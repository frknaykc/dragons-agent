// Synchronous, handle-owned Windows checkpoint I/O. No CRT descriptor conversion:
// Node's CRT file-descriptor table is not shared with native addons.
#include <node_api.h>
#include <windows.h>
#include <cmath>
#include <cstdint>
#include <limits>
#include <mutex>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {
constexpr uint32_t kReadWrite = 2, kCreate = 256, kExclusive = 1024;
constexpr size_t kMaxTransfer = 262144;
struct NativeHandle { HANDLE value; std::vector<HANDLE> parents; };
std::mutex liveMutex;
std::unordered_set<NativeHandle*> live;

napi_value Throw(napi_env env, const char* code, const char* message) {
  napi_value text, error, value;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
  napi_create_error(env, nullptr, text, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, error, "code", value);
  napi_throw(env, error);
  return nullptr;
}
napi_value WinError(napi_env env, DWORD error) {
  const char* code = "EIO";
  if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) code = "EEXIST";
  else if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) code = "ENOENT";
  else if (error == ERROR_ACCESS_DENIED || error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION) code = "EACCES";
  else if (error == ERROR_INVALID_NAME || error == ERROR_BAD_PATHNAME || error == ERROR_INVALID_PARAMETER) code = "EINVAL";
  std::string message = std::string("Checkpoint Windows handle operation failed (") + code + ", Win32 " + std::to_string(error) + ").";
  return Throw(env, code, message.c_str());
}
bool Args(napi_env env, napi_callback_info info, size_t count, napi_value* args) {
  napi_value received[6] = {};
  size_t actual = count + 1;
  if (count > 5 || napi_get_cb_info(env, info, &actual, received, nullptr, nullptr) != napi_ok || actual != count) {
    Throw(env, "EINVAL", "Incorrect checkpoint native argument count.");
    return false;
  }
  for (size_t i = 0; i < count; ++i) args[i] = received[i];
  return true;
}
bool Number(napi_env env, napi_value value, double max, double* result) {
  napi_valuetype type;
  double number;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) ||
      number < 0 || number > max || std::floor(number) != number) {
    Throw(env, "EINVAL", "Expected a nonnegative, bounded integer.");
    return false;
  }
  *result = number;
  return true;
}
bool Path(napi_env env, napi_value value, std::wstring* result) {
  napi_valuetype type;
  size_t length;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > 32767) {
    Throw(env, "EINVAL", "Expected a nonempty bounded Windows path.");
    return false;
  }
  std::vector<char16_t> chars(length + 1);
  size_t copied;
  if (napi_get_value_string_utf16(env, value, chars.data(), chars.size(), &copied) != napi_ok || copied != length) {
    Throw(env, "EINVAL", "Invalid Windows path string.");
    return false;
  }
  for (size_t i = 0; i < length; ++i) {
    if (chars[i] == 0) {
      Throw(env, "EINVAL", "Windows path contains a NUL character.");
      return false;
    }
  }
  result->clear();
  result->reserve(length);
  for (size_t i = 0; i < length; ++i) result->push_back(static_cast<wchar_t>(chars[i]));
  return true;
}
bool Inspect(napi_env env, HANDLE handle, bool directory, BY_HANDLE_FILE_INFORMATION* info);
void CloseParents(std::vector<HANDLE>* parents) {
  for (auto it = parents->rbegin(); it != parents->rend(); ++it) CloseHandle(*it);
  parents->clear();
}
// Pin every ancestor without sharing DELETE. A junction or rename cannot be
// substituted while a checkpoint handle is open, including for a new leaf.
bool PinAncestors(napi_env env, const std::wstring& path, std::vector<HANDLE>* parents) {
  if (path.size() < 4 || !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))
      || path[1] != L':' || path[2] != L'\\' || path.back() == L'\\'
      || path.find(L'/') != std::wstring::npos || path.find(L':', 2) != std::wstring::npos) {
    Throw(env, "EINVAL", "Checkpoint requires a normalized absolute drive path.");
    return false;
  }
  size_t start = 3;
  while (start < path.size()) {
    const size_t end = path.find(L'\\', start);
    const std::wstring part = path.substr(start, end == std::wstring::npos ? end : end - start);
    if (part.empty() || part == L"." || part == L"..") {
      CloseParents(parents);
      Throw(env, "EINVAL", "Checkpoint refuses noncanonical path components.");
      return false;
    }
    if (end == std::wstring::npos) break;
    const std::wstring ancestor = path.substr(0, end);
    HANDLE handle = CreateFileW(ancestor.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      const DWORD error = GetLastError(); CloseParents(parents); WinError(env, error); return false;
    }
    BY_HANDLE_FILE_INFORMATION info;
    if (!Inspect(env, handle, true, &info)) {
      CloseHandle(handle); CloseParents(parents); return false;
    }
    parents->push_back(handle);
    start = end + 1;
  }
  return true;
}
void Finalize(napi_env, void* data, void*) {
  auto* handle = static_cast<NativeHandle*>(data);
  { std::lock_guard<std::mutex> guard(liveMutex); live.erase(handle); }
  if (handle->value != INVALID_HANDLE_VALUE) CloseHandle(handle->value);
  CloseParents(&handle->parents);
  delete handle;
}
bool GetHandle(napi_env env, napi_value value, NativeHandle** result) {
  napi_valuetype type;
  void* raw = nullptr;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external ||
      napi_get_value_external(env, value, &raw) != napi_ok) {
    Throw(env, "EINVAL", "Expected a checkpoint native handle.");
    return false;
  }
  auto* handle = static_cast<NativeHandle*>(raw);
  { std::lock_guard<std::mutex> guard(liveMutex);
    if (!live.count(handle) || handle->value == INVALID_HANDLE_VALUE) {
      Throw(env, "EBADF", "Checkpoint native handle is closed or foreign.");
      return false;
    }
  }
  *result = handle;
  return true;
}
bool Inspect(napi_env env, HANDLE handle, bool directory, BY_HANDLE_FILE_INFORMATION* info) {
  if (GetFileType(handle) != FILE_TYPE_DISK) {
    Throw(env, "EINVAL", "Checkpoint requires a disk file or directory.");
    return false;
  }
  if (!GetFileInformationByHandle(handle, info)) { WinError(env, GetLastError()); return false; }
  if ((info->dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      ((info->dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) {
    Throw(env, "EINVAL", "Checkpoint refuses a reparse point or unexpected file type.");
    return false;
  }
  return true;
}
double TimeMilliseconds(LARGE_INTEGER time) {
  // FILETIME ticks (1601 epoch) to JS milliseconds (1970 epoch).
  // Match libuv's integer timespec conversion, then Node's milliseconds getter.
  const int64_t ticks = time.QuadPart - INT64_C(116444736000000000);
  const int64_t seconds = ticks / INT64_C(10000000);
  const int64_t remainder = ticks % INT64_C(10000000);
  return static_cast<double>(seconds) * 1000.0 + static_cast<double>(remainder) / 10000.0;
}
void SetNumber(napi_env env, napi_value object, const char* key, double number) {
  napi_value value;
  napi_create_double(env, number, &value);
  napi_set_named_property(env, object, key, value);
}
void SetBool(napi_env env, napi_value object, const char* key, bool flag) {
  napi_value value;
  napi_get_boolean(env, flag, &value);
  napi_set_named_property(env, object, key, value);
}
napi_value Metadata(napi_env env, HANDLE handle, bool directory) {
  BY_HANDLE_FILE_INFORMATION info;
  if (!Inspect(env, handle, directory, &info)) return nullptr;
  FILE_BASIC_INFO basic;
  if (!GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))) return WinError(env, GetLastError());
  napi_value object;
  napi_create_object(env, &object);
  const uint64_t index = (static_cast<uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
  const uint64_t length = (static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
  SetNumber(env, object, "dev", info.dwVolumeSerialNumber);
  SetNumber(env, object, "ino", static_cast<double>(index));
  const std::string fileId = std::to_string(index);
  napi_value fileIdValue;
  napi_create_string_utf8(env, fileId.c_str(), fileId.size(), &fileIdValue);
  napi_set_named_property(env, object, "fileId", fileIdValue);
  SetNumber(env, object, "nlink", info.nNumberOfLinks);
  SetNumber(env, object, "size", static_cast<double>(length));
  // libuv/Node on Windows reports 0666 for writable files and 0444 for read-only.
  SetNumber(env, object, "mode", (directory ? 0040000 : 0100000) |
      ((info.dwFileAttributes & FILE_ATTRIBUTE_READONLY) ? 0444 : 0666));
  SetNumber(env, object, "mtimeMs", TimeMilliseconds(basic.LastWriteTime));
  SetNumber(env, object, "ctimeMs", TimeMilliseconds(basic.ChangeTime));
  SetBool(env, object, "isFile", !directory);
  if (directory) SetBool(env, object, "isDirectory", true);
  return object;
}
napi_value OpenNoFollow(napi_env env, napi_callback_info callback) {
  napi_value args[2];
  if (!Args(env, callback, 2, args)) return nullptr;
  std::wstring path;
  double raw;
  if (!Path(env, args[0], &path) || !Number(env, args[1], UINT32_MAX, &raw)) return nullptr;
  const uint32_t flags = static_cast<uint32_t>(raw);
  const bool create = flags == (kReadWrite | kCreate | kExclusive);
  if (!create && flags != 0 && flags != kReadWrite) return Throw(env, "EINVAL", "Unsupported checkpoint open flags.");
  std::vector<HANDLE> parents;
  if (!PinAncestors(env, path, &parents)) return nullptr;
  HANDLE handle = CreateFileW(path.c_str(), flags ? GENERIC_READ | GENERIC_WRITE | DELETE : GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      create ? CREATE_NEW : OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) { const DWORD error = GetLastError(); CloseParents(&parents); return WinError(env, error); }
  BY_HANDLE_FILE_INFORMATION info;
  if (!Inspect(env, handle, false, &info)) { CloseHandle(handle); CloseParents(&parents); return nullptr; }
  auto* owned = new NativeHandle{handle, std::move(parents)};
  napi_value external;
  if (napi_create_external(env, owned, Finalize, nullptr, &external) != napi_ok) {
    CloseHandle(handle); CloseParents(&owned->parents); delete owned;
    return Throw(env, "EIO", "Could not allocate checkpoint native handle.");
  }
  { std::lock_guard<std::mutex> guard(liveMutex); live.insert(owned); }
  return external;
}
napi_value Stat(napi_env env, napi_callback_info callback) {
  napi_value args[1]; NativeHandle* handle;
  if (!Args(env, callback, 1, args) || !GetHandle(env, args[0], &handle)) return nullptr;
  return Metadata(env, handle->value, false);
}
bool TransferArgs(napi_env env, napi_callback_info callback, NativeHandle** handle,
                  unsigned char** bytes, DWORD* length, LARGE_INTEGER* position) {
  napi_value args[5];
  if (!Args(env, callback, 5, args) || !GetHandle(env, args[0], handle)) return false;
  bool buffer, instance;
  napi_value global, constructor;
  void* data;
  size_t size;
  if (napi_is_buffer(env, args[1], &buffer) != napi_ok || !buffer ||
      napi_get_global(env, &global) != napi_ok ||
      napi_get_named_property(env, global, "Buffer", &constructor) != napi_ok ||
      napi_instanceof(env, args[1], constructor, &instance) != napi_ok || !instance ||
      napi_get_buffer_info(env, args[1], &data, &size) != napi_ok) {
    Throw(env, "EINVAL", "Expected a Buffer."); return false;
  }
  double start, count, location;
  if (!Number(env, args[2], static_cast<double>(size), &start) ||
      !Number(env, args[3], kMaxTransfer, &count) ||
      !Number(env, args[4], kMaxTransfer, &location)) return false;
  if (count > static_cast<double>(size) - start) {
    Throw(env, "EINVAL", "Buffer transfer exceeds its bounds."); return false;
  }
  *bytes = static_cast<unsigned char*>(data) + static_cast<size_t>(start);
  *length = static_cast<DWORD>(count);
  position->QuadPart = static_cast<LONGLONG>(location);
  return true;
}
napi_value Transfer(napi_env env, napi_callback_info callback, bool writing) {
  NativeHandle* handle; unsigned char* bytes; DWORD length; LARGE_INTEGER position;
  if (!TransferArgs(env, callback, &handle, &bytes, &length, &position)) return nullptr;
  if (writing && static_cast<uint64_t>(position.QuadPart) + length > kMaxTransfer)
    return Throw(env, "EINVAL", "Checkpoint write exceeds the file image limit.");
  BY_HANDLE_FILE_INFORMATION info;
  if (!Inspect(env, handle->value, false, &info)) return nullptr;
  if (!SetFilePointerEx(handle->value, position, nullptr, FILE_BEGIN)) return WinError(env, GetLastError());
  DWORD done = 0;
  BOOL ok = writing ? WriteFile(handle->value, bytes, length, &done, nullptr)
                    : ReadFile(handle->value, bytes, length, &done, nullptr);
  if (!ok) return WinError(env, GetLastError());
  napi_value result;
  napi_create_uint32(env, done, &result);
  return result;
}
napi_value Read(napi_env env, napi_callback_info callback) { return Transfer(env, callback, false); }
napi_value Write(napi_env env, napi_callback_info callback) { return Transfer(env, callback, true); }
napi_value Truncate(napi_env env, napi_callback_info callback) {
  napi_value args[2]; NativeHandle* handle; double length;
  if (!Args(env, callback, 2, args) || !GetHandle(env, args[0], &handle) ||
      !Number(env, args[1], kMaxTransfer, &length)) return nullptr;
  BY_HANDLE_FILE_INFORMATION info;
  if (!Inspect(env, handle->value, false, &info)) return nullptr;
  LARGE_INTEGER position; position.QuadPart = static_cast<LONGLONG>(length);
  if (!SetFilePointerEx(handle->value, position, nullptr, FILE_BEGIN) || !SetEndOfFile(handle->value))
    return WinError(env, GetLastError());
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value Chmod(napi_env env, napi_callback_info callback) {
  napi_value args[2]; NativeHandle* handle; double mode;
  if (!Args(env, callback, 2, args) || !GetHandle(env, args[0], &handle) ||
      !Number(env, args[1], 07777, &mode)) return nullptr;
  BY_HANDLE_FILE_INFORMATION info;
  if (!Inspect(env, handle->value, false, &info)) return nullptr;
  FILE_BASIC_INFO basic;
  if (!GetFileInformationByHandleEx(handle->value, FileBasicInfo, &basic, sizeof(basic))) return WinError(env, GetLastError());
  if (static_cast<uint32_t>(mode) & 0222) basic.FileAttributes &= ~FILE_ATTRIBUTE_READONLY;
  else basic.FileAttributes |= FILE_ATTRIBUTE_READONLY;
  if (!SetFileInformationByHandle(handle->value, FileBasicInfo, &basic, sizeof(basic))) return WinError(env, GetLastError());
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value Remove(napi_env env, napi_callback_info callback) {
  napi_value args[1]; NativeHandle* handle;
  if (!Args(env, callback, 1, args) || !GetHandle(env, args[0], &handle)) return nullptr;
  BY_HANDLE_FILE_INFORMATION info;
  if (!Inspect(env, handle->value, false, &info)) return nullptr;
  if (info.nNumberOfLinks != 1) return Throw(env, "EINVAL", "Checkpoint refuses to delete a linked file.");
  FILE_DISPOSITION_INFO_EX disposition{};
  disposition.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS;
  // Older Windows SDKs omit this enum member while exposing the structure.
  if (!SetFileInformationByHandle(handle->value, static_cast<FILE_INFO_BY_HANDLE_CLASS>(21), &disposition, sizeof(disposition)))
    return WinError(env, GetLastError());
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value Close(napi_env env, napi_callback_info callback) {
  napi_value args[1]; NativeHandle* handle;
  if (!Args(env, callback, 1, args) || !GetHandle(env, args[0], &handle)) return nullptr;
  HANDLE value = handle->value;
  handle->value = INVALID_HANDLE_VALUE;
  const BOOL closed = CloseHandle(value);
  const DWORD error = closed ? 0 : GetLastError();
  CloseParents(&handle->parents);
  if (!closed) return WinError(env, error);
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value InspectDirectoryNoFollow(napi_env env, napi_callback_info callback) {
  napi_value args[1]; std::wstring path;
  if (!Args(env, callback, 1, args) || !Path(env, args[0], &path)) return nullptr;
  HANDLE handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return WinError(env, GetLastError());
  napi_value result = Metadata(env, handle, true);
  CloseHandle(handle);
  return result;
}
napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"openNoFollow", nullptr, OpenNoFollow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stat", nullptr, Stat, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"truncate", nullptr, Truncate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"chmod", nullptr, Chmod, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectDirectoryNoFollow", nullptr, InspectDirectoryNoFollow, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok) return nullptr;
  return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

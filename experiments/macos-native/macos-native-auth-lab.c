/* Disposable OS peer-authentication receiver; NEVER an activation helper.
 * Public Mach IPC supplies a kernel-generated per-message audit trailer.
 * kSecGuestAttributeAudit binds Security lookup to that sender instance, not PID.
 * Policy is an explicit LAB argument (test-pinned ad-hoc cdhash), NOT a production
 * trust root. No paths are installed, no service registered, no update performed.
 * A public posix_spawn special-port attribute gives ONLY the disposable sender
 * a private bootstrap port. No launchd registration occurs; this intentionally
 * service-less host is not a template for a GUI app bootstrap environment.
 * Possession is NOT authorization: exec-delegated rights are checked anew.
 */
#include <errno.h>
#include <mach/mach.h>
#include <Security/Security.h>
#include <sys/wait.h>
#include <spawn.h>
extern char **environ;
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

struct frame { mach_msg_header_t header; uint32_t version; uint32_t operation; };

static const char *authenticate(mach_msg_header_t *message, size_t capacity,
                                SecRequirementRef requirement) {
  if (message->msgh_size != sizeof(struct frame) ||
      (message->msgh_bits & MACH_MSGH_BITS_COMPLEX) || message->msgh_id != 78 ||
      message->msgh_remote_port != MACH_PORT_NULL) return "DENY_SHAPE";
  struct frame *frame = (struct frame *)message;
  if (frame->version != 1 || frame->operation != 1) return "DENY_SHAPE";
  size_t offset = (message->msgh_size + 3u) & ~3u;
  if (offset > capacity || capacity - offset < sizeof(mach_msg_audit_trailer_t))
    return "DENY_AUDIT";
  mach_msg_audit_trailer_t *trailer = (void *)((char *)message + offset);
  if (trailer->msgh_trailer_type != MACH_MSG_TRAILER_FORMAT_0 ||
      trailer->msgh_trailer_size < sizeof(*trailer)) return "DENY_AUDIT";
  CFDataRef audit = CFDataCreate(NULL, (const UInt8 *)&trailer->msgh_audit,
                               sizeof(trailer->msgh_audit));
  if (!audit) return "DENY_AUDIT";
  const void *key = kSecGuestAttributeAudit;
  const void *value = audit;
  CFDictionaryRef attributes = CFDictionaryCreate(NULL, &key, &value, 1,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  OSStatus status = attributes ? SecCodeCopyGuestWithAttributes(NULL, attributes,
      kSecCSDefaultFlags, &code) : errSecAllocate;
  if (attributes) CFRelease(attributes);
  CFRelease(audit);
  if (status != errSecSuccess || !code) return "DENY_AUDIT";
  status = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
  CFRelease(code);
  return status == errSecSuccess ? "LAB_PEER_AUTHENTICATED_ACTIVATION_UNSUPPORTED" : "DENY_IDENTITY";
}

int main(int argc, char **argv) {
  if (argc != 5 || strcmp(argv[1], "--disposable-peer-auth-lab")) return 64;
  /* Explicit spawn inheritance avoids legacy registered-port slots, which
   * libSystem may reset. The receiver retains its normal bootstrap environment. */
  mach_port_t port = MACH_PORT_NULL;
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) ||
      mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND)) return 70;
  int hold[2];
  if (pipe(hold)) return 70;
  posix_spawnattr_t attr;
  posix_spawn_file_actions_t actions;
  if (posix_spawnattr_init(&attr) || posix_spawn_file_actions_init(&actions) ||
      posix_spawnattr_setflags(&attr, POSIX_SPAWN_CLOEXEC_DEFAULT) ||
      posix_spawnattr_setspecialport_np(&attr, port, TASK_BOOTSTRAP_PORT) ||
      posix_spawn_file_actions_adddup2(&actions, hold[0], STDIN_FILENO) ||
      posix_spawn_file_actions_addclose(&actions, hold[0]) ||
      posix_spawn_file_actions_addclose(&actions, hold[1])) return 70;
  char *args[] = {argv[2], "--send", argv[4], NULL};
  pid_t child;
  int spawned = posix_spawn(&child, argv[2], &actions, &attr, args, environ);
  posix_spawnattr_destroy(&attr);
  posix_spawn_file_actions_destroy(&actions);
  close(hold[0]);
  if (spawned) { close(hold[1]); return 70; }
  CFStringRef text = CFStringCreateWithCString(NULL, argv[3], kCFStringEncodingUTF8);
  SecRequirementRef requirement = NULL;
  const char *result = "DENY_POLICY";
  if (text && SecRequirementCreateWithString(text, kSecCSDefaultFlags, &requirement) == errSecSuccess) {
    union { mach_msg_header_t align; unsigned char bytes[4096]; } buffer = {0};
    mach_msg_return_t received = mach_msg(&buffer.align,
        MACH_RCV_MSG | MACH_RCV_TIMEOUT |
        MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
        MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
        0, sizeof(buffer), port, 3000, MACH_PORT_NULL);
    if (received != MACH_MSG_SUCCESS) fprintf(stderr, "Mach receive failed: %s (%d)\n", mach_error_string(received), received);
    result = received == MACH_MSG_SUCCESS ? authenticate(&buffer.align, sizeof(buffer), requirement) : "DENY_TRANSPORT";
    if (received == MACH_MSG_SUCCESS) mach_msg_destroy(&buffer.align);
  }
  if (requirement) CFRelease(requirement);
  if (text) CFRelease(text);
  /* Bound cleanup even when an adversarial fixture refuses to terminate. */
  int status;
  pid_t exited = waitpid(child, &status, WNOHANG);
  if (exited == child) fprintf(stderr, "Sender exited before cleanup: status=%d\n", status);
  else {
    kill(child, SIGKILL);
    while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) return 70; }
  }
  close(hold[1]);
  mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
  mach_port_deallocate(mach_task_self(), port);
  puts(result);
  return 0;
}

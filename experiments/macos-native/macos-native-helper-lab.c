/* Disposable lifetime experiment ONLY: no installer, paths, launch or data access.
 * Build outside the .app using test-macos-native-helper.sh. Not packaged/enabled.
 * fd 3: inherited AF_UNIX stream socketpair created by the direct host parent.
 * stdout: test observer only, never an activation/data-release capability.
 * LOCAL_PEERPID reports the peer socket's last PID (XNU uipc_usrreq.c), NOT
 * immutable creator identity or a per-message audit token. Check it after WAIT.
 * Inherited/delegated endpoints and same-account compromise are outside this
 * lab's trusted-host/no-delegation precondition. Production needs signed,
 * audit-token-bound peer authentication,
 * protected helper bootstrap, descendant/data sandboxing and durable recovery.
 */
#include <sys/event.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

static int deny(void) { return 64; }
int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc != 3 || strcmp(argv[1], "--disposable-lifetime-lab") != 0) return deny();
  if (!argv[2][0]) return deny();
  for (const char *p = argv[2]; *p; ++p) if (*p < '0' || *p > '9') return deny();
  errno = 0;
  char *end = NULL;
  long value = strtol(argv[2], &end, 10);
  if (errno || *end || value <= 1 || value > INT_MAX) return deny();
  pid_t parent = (pid_t)value;
  if (getppid() != parent) return deny();
  int type = 0;
  socklen_t size = sizeof(type);
  struct sockaddr_un address;
  socklen_t address_size = sizeof(address);
  pid_t peer = 0;
  socklen_t peer_size = sizeof(peer);
  uid_t uid; gid_t gid;
  if (getsockopt(3, SOL_SOCKET, SO_TYPE, &type, &size) || type != SOCK_STREAM ||
      getpeername(3, (struct sockaddr *)&address, &address_size) || address.sun_family != AF_UNIX ||
      getpeereid(3, &uid, &gid) || uid != geteuid()) return deny();

  int queue = kqueue();
  if (queue < 0) return deny();
  struct kevent change, event;
  EV_SET(&change, (uintptr_t)parent, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  /* Register synchronously, then recheck parent binding before announcing READY.
   * If parent died before/during registration, deny. Once registered, kqueue
   * watches that process instance, not a future recycled PID. No kill(pid,0).
   */
  if (kevent(queue, &change, 1, NULL, 0, NULL) < 0 || getppid() != parent) return deny();
  struct pollfd channel = { .fd = 3, .events = POLLIN };
  if (poll(&channel, 1, 2000) <= 0) return deny();
  char frame[5];
  /* One bounded packet by contract; partial/extra input fails closed. */
  if (recv(3, frame, sizeof(frame), MSG_DONTWAIT) != 4 || memcmp(frame, "WAIT", 4)) return deny();
  if (getsockopt(3, SOL_LOCAL, LOCAL_PEERPID, &peer, &peer_size) ||
      peer_size != sizeof(peer) || peer != parent || getppid() != parent) return deny();
  if (write(STDOUT_FILENO, "READY\n", 6) != 6) return deny();
  struct timespec timeout = { .tv_sec = 3, .tv_nsec = 0 };
  int result = kevent(queue, NULL, 0, &event, 1, &timeout);
  if (result != 1 || event.filter != EVFILT_PROC || event.ident != (uintptr_t)parent ||
      (event.flags & EV_ERROR) || !(event.fflags & NOTE_EXIT)) return deny();
  /* Diagnostic only: deliberately NOT connected to lifecycle activation. */
  const char observed[] = "LAB_HOST_EXIT_OBSERVED\n";
  if (write(STDOUT_FILENO, observed, sizeof(observed) - 1) != sizeof(observed) - 1) return deny();
  close(queue);
  close(3);
  return 0;
}

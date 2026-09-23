/* Native black-box tests. Every host/helper is disposable, no Electron/Node. */
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "FAIL line %d: %s (errno %d)\n", __LINE__, #x, errno); exit(1); } } while (0)
static void readable(int fd) {
  struct pollfd p = { .fd = fd, .events = POLLIN };
  CHECK(poll(&p, 1, 5000) == 1);
}
static void line(int fd, const char *expected) {
  char text[128]; size_t n = 0;
  while (n < sizeof(text) - 1) {
    readable(fd);
    CHECK(read(fd, text + n, 1) == 1);
    if (text[n++] == '\n') break;
  }
  text[n] = 0;
  CHECK(strcmp(text, expected) == 0);
}
static void quiet(int fd) {
  struct pollfd p = { .fd = fd, .events = POLLIN };
  CHECK(poll(&p, 1, 150) == 0);
}
static void eof(int fd) { char c; readable(fd); CHECK(read(fd, &c, 1) == 0); }

static void run(const char *helper, const char *name, int mode) {
  int output[2], command[2], sockets[2] = {-1, -1};
  CHECK(pipe(output) == 0 && pipe(command) == 0);
  /* Wrong peer: supervisor owns/writes the endpoint; host never uses it. */
  if (mode == 2) {
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    CHECK(write(sockets[0], "WAIT", 4) == 4);
  }
  fflush(stdout);
  pid_t host = fork(); CHECK(host >= 0);
  if (host == 0) {
    alarm(8);
    close(output[0]); close(command[1]);
    if (mode != 2) CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    char parent[32];
    snprintf(parent, sizeof(parent), "%ld", (long)(mode == 1 ? getppid() : getpid()));
    pid_t child = fork(); CHECK(child >= 0);
    if (child == 0) {
      if (mode == 13) { char c; CHECK(read(command[0], &c, 1) == 1); }
      CHECK(dup2(output[1], STDOUT_FILENO) == STDOUT_FILENO);
      CHECK(dup2(mode == 5 ? command[0] : sockets[1], 3) == 3);
      for (int fd = 4, limit = getdtablesize(); fd < limit; ++fd) close(fd);
      execl(helper, helper, mode == 6 ? "--activate" : "--disposable-lifetime-lab",
            mode == 7 ? "0" : mode == 8 ? "999999999999999999999" : parent, (char *)NULL);
      _exit(127);
    }
    close(output[1]); close(sockets[1]);
    if (mode == 13) _exit(0);
    if (mode != 9 && mode != 2) {
      const char *frame = mode == 3 ? "FAKE" : mode == 4 ? "WAITX" : "WAIT";
      /* Negative helper can refuse before host sends, so EPIPE is expected. */
      (void)write(sockets[0], frame, strlen(frame));
    }
    if (mode == 10) {
      char c; CHECK(read(command[0], &c, 1) == 1 && c == 'C');
      close(sockets[0]); sockets[0] = -1;
    }
    if (mode == 0 || mode == 10 || mode == 11) {
      char c; CHECK(read(command[0], &c, 1) == 1);
      /* Exit requested only AFTER supervisor proved no early observation. */
      _exit(0);
    }
    int status;
    CHECK(waitpid(child, &status, 0) == child);
    _exit(WIFEXITED(status) && WEXITSTATUS(status) == 64 ? 0 : 1);
  }
  close(output[1]); close(command[0]);
  if (sockets[0] != -1) { close(sockets[0]); close(sockets[1]); }
  if (mode == 13) {
    int status;
    CHECK(waitpid(host, &status, 0) == host);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    CHECK(write(command[1], "G", 1) == 1);
  }
  if (mode == 0 || mode == 10 || mode == 11 || mode == 12) {
    line(output[0], "READY\n");
    if (mode == 10) CHECK(write(command[1], "C", 1) == 1);
    quiet(output[0]);
    CHECK(kill(host, 0) == 0);
    if (mode != 12) {
      if (mode == 11) CHECK(kill(host, SIGKILL) == 0);
      else CHECK(write(command[1], "X", 1) == 1);
      int status;
      CHECK(waitpid(host, &status, 0) == host);
      CHECK(mode == 11 ? WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL : WIFEXITED(status) && WEXITSTATUS(status) == 0);
      line(output[0], "LAB_HOST_EXIT_OBSERVED\n");
    }
  }
  eof(output[0]);
  if (mode != 0 && mode != 10 && mode != 11 && mode != 13) {
    int status;
    CHECK(waitpid(host, &status, 0) == host);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
  }
  close(output[0]); close(command[1]);
  printf("PASS %s\n", name);
}
int main(int argc, char **argv) {
  CHECK(argc == 2);
  signal(SIGPIPE, SIG_IGN);
  alarm(40);
  const char *names[] = {
    "actual host exit gates observation", "wrong live parent rejected",
    "wrong OS socket peer rejected", "malformed command rejected",
    "oversized command rejected", "pipe instead of socket rejected",
    "activation mode rejected", "invalid PID rejected", "overflow PID rejected",
    "missing handshake times out closed", "channel EOF is not host exit",
    "SIGKILL host exit observed", "live host deadline never grants observation",
    "host exited before bootstrap rejected"
  };
  for (int i = 0; i < 14; ++i) run(argv[1], names[i], i);
  return 0;
}

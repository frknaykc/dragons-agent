/* Real disposable sender. Compiled/signed as two different ad-hoc identities.
 * stdin keeps the sender alive while Security validates its kernel audit token.
 * No caller PID, claimed Team ID or payload token is used for authorization. */
#include <mach/mach.h>
#include <unistd.h>
#include <string.h>
#include <stdint.h>
#include <stdio.h>

struct frame { mach_msg_header_t header; uint32_t version; uint32_t operation; };
int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "--send")) return 64;
  /* exec preserves the inherited private bootstrap capability, but changes code
   * identity: this case catches authorization of the original bootstrap host. */
  if (!strncmp(argv[2], "delegate:", 9)) {
    execl(argv[2] + 9, argv[2] + 9, "--send", "valid", (char *)NULL);
    return 70;
  }
  mach_port_t destination = MACH_PORT_NULL;
  if (task_get_special_port(mach_task_self(), TASK_BOOTSTRAP_PORT, &destination) ||
      destination == MACH_PORT_NULL) return 70;
  union { struct frame frame; unsigned char bytes[256]; } message = {0};
  message.frame.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  message.frame.header.msgh_size = sizeof(struct frame);
  message.frame.header.msgh_remote_port = destination;
  message.frame.header.msgh_id = 78;
  message.frame.version = 1;
  message.frame.operation = 1;
  if (!strcmp(argv[2], "silent")) {
    char byte;
    (void)read(STDIN_FILENO, &byte, 1);
    return 0;
  }
  if (!strcmp(argv[2], "complex")) {
    message.frame.header.msgh_bits |= MACH_MSGH_BITS_COMPLEX;
    message.frame.version = 0; /* kernel-valid body with zero descriptors */
  } else if (!strcmp(argv[2], "oversized")) message.frame.header.msgh_size = sizeof(message);
  else if (!strcmp(argv[2], "wrong-version")) message.frame.version = 2;
  else if (!strcmp(argv[2], "activate")) message.frame.operation = 2;
  else if (!strcmp(argv[2], "wrong-id")) message.frame.header.msgh_id = 79;
  else if (!strcmp(argv[2], "short")) message.frame.header.msgh_size -= 4;
  else if (!strcmp(argv[2], "claimed-team")) {
    memcpy(message.bytes + sizeof(struct frame), "TEAM=TRUSTED", 12);
    message.frame.header.msgh_size += 12;
  } else if (!strcmp(argv[2], "forged-audit")) {
    memset(message.bytes + sizeof(struct frame), 0x78, sizeof(audit_token_t));
    message.frame.header.msgh_size += sizeof(audit_token_t);
  } else if (!strcmp(argv[2], "reply-port")) {
    mach_port_t reply;
    if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply)) return 70;
    message.frame.header.msgh_local_port = reply;
    message.frame.header.msgh_bits |= MACH_MSGH_BITS(0, MACH_MSG_TYPE_MAKE_SEND_ONCE);
  } else if (strcmp(argv[2], "valid")) return 64;
  mach_msg_return_t sent = mach_msg(&message.frame.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
      message.frame.header.msgh_size, 0, MACH_PORT_NULL, 2000, MACH_PORT_NULL);
  if (sent) { fprintf(stderr, "Mach send failed: %s (%d)\n", mach_error_string(sent), sent); return 70; }
  char byte;
  (void)read(STDIN_FILENO, &byte, 1);
  return 0;
}

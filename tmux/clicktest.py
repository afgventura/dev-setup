#!/usr/bin/env python3
"""Attach a private client to the outer 'ui' tmux in a pty and inject real
SGR mouse-click bytes, so sidebar clicks can be tested without touching the
screen. Usage: clicktest.py ROW [ROW ...]   (sidebar rows, 1 = first tab)"""
import fcntl, os, pty, struct, subprocess, sys, termios, time

TMUX = "/opt/homebrew/bin/tmux"
# match the real client's size so attaching here never resizes the user's view
def _size():
    out = subprocess.run([TMUX, "-L", "ui", "display", "-p", "#{client_width} #{client_height}"],
                         capture_output=True, text=True).stdout.split()
    return (int(out[0]), int(out[1])) if len(out) == 2 else (255, 72)
COLS, ROWS = _size()

def main():
    rows = [int(a) for a in sys.argv[1:]] or [1]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.pop("TMUX", None)
        os.execv(TMUX, [TMUX, "-L", "ui", "attach", "-t", "ui"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    os.set_blocking(fd, False)
    def drain():
        try:
            while os.read(fd, 65536):
                pass
        except BlockingIOError:
            pass
    time.sleep(1.0); drain()
    for r in rows:
        y = 2 * r + 3  # 1-based: rows 1-2 margin, 3-4 header, then item/gap pairs
        os.write(fd, f"\x1b[<0;5;{y}M\x1b[<0;5;{y}m".encode())
        time.sleep(0.7); drain()
        active = subprocess.run([TMUX, "display", "-t", "main", "-p", "#I #W"],
                                capture_output=True, text=True).stdout.strip()
        side = subprocess.run([TMUX, "-L", "ui", "capture-pane", "-p", "-t", "ui:.0"],
                              capture_output=True, text=True).stdout.splitlines()
        marker = next((i for i, l in enumerate(side) if "▶" in l), None)
        focus = subprocess.run([TMUX, "-L", "ui", "display", "-p", "#{pane_index}"],
                               capture_output=True, text=True).stdout.strip()
        print(f"click row {r} → active: {active!r:30} ▶ on row {marker}  focus pane {focus}")
    tty = os.ttyname(fd) if False else None
    subprocess.run([TMUX, "-L", "ui", "detach-client", "-t", os.readlink(f"/dev/fd/{fd}") if False else _tty(pid)],
                   capture_output=True)
    time.sleep(0.3)
    try: os.kill(pid, 15)
    except ProcessLookupError: pass
    subprocess.run([TMUX, "-L", "ui", "refresh-client"], capture_output=True)  # full redraw for the real client

def _tty(pid):
    out = subprocess.run(["ps", "-o", "tty=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return "/dev/" + out

main()

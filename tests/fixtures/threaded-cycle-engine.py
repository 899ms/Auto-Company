import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

engine, state = sys.argv[1:]
root = Path(state)
(root / "root.pid").write_text(str(os.getpid()))
signal.signal(signal.SIGTERM, lambda *_: (root / "root.term").write_text("TERM"))
thread = threading.Thread(target=lambda: subprocess.Popen(
    ["bash", engine, "child-ignore", state], start_new_session=True
).wait())
thread.start()
thread.join()
while True:
    time.sleep(0.1)

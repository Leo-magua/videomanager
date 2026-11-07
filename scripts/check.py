"""Run isolated regressions from a clean checkout; no live server needed."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
node = "node"
for path in sorted((root / "tests").glob("*_regression.py")):
    print(f"Running {path.relative_to(root)}", flush=True)
    subprocess.run([sys.executable, str(path)], cwd=root, check=True)
for path in sorted((root / "tests").glob("*_regression.mjs")):
    print(f"Running {path.relative_to(root)}", flush=True)
    subprocess.run([node, str(path)], cwd=root, check=True)
print("All isolated regressions passed.")

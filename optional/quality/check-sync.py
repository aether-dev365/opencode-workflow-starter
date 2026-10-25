"""Report registered couplings that changed without their related files."""

import sys
sys.dont_write_bytecode = True

from pathlib import Path
from quality_sync import main


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:], here=Path(__file__).resolve().parent))

import json
import re
from pathlib import Path
from typing import Dict, List, Tuple


ROOT = Path(__file__).resolve().parents[2]
APPS_DIR = ROOT / 'apps'
BASE_CONFIG_FILE = ROOT / 'renovate.json'
OUTPUT_FILE = ROOT / '.github' / 'renovate-runtime.json'
SEMVER_PATTERN = re.compile(r'^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$')


def parse_version(version: str) -> Tuple[int, int, int] | None:
    match = SEMVER_PATTERN.match(version)

    if not match:
        return None

    parts = match.groups(default='0')
    return tuple(int(part) for part in parts)


def get_old_version_ignore_paths() -> List[str]:
    ignore_paths: List[str] = []

    if not APPS_DIR.exists():
        return ignore_paths

    for app_dir in sorted(path for path in APPS_DIR.iterdir() if path.is_dir()):
        versions: Dict[str, Tuple[int, int, int]] = {}

        for version_dir in sorted(path for path in app_dir.iterdir() if path.is_dir()):
            if not any(version_dir.rglob('docker-compose.yml')):
                continue

            parsed = parse_version(version_dir.name)

            if parsed is not None:
                versions[version_dir.name] = parsed

        if len(versions) <= 1:
            continue

        latest_version = max(versions, key=lambda version: versions[version])

        for version in versions:
            if version != latest_version:
                ignore_paths.append(f'apps/{app_dir.name}/{version}/**')

    return ignore_paths


def main() -> None:
    with BASE_CONFIG_FILE.open(encoding='utf-8') as base_config_file:
        base_config = json.load(base_config_file)

    ignore_paths = base_config.get('ignorePaths', []) + get_old_version_ignore_paths()
    ignore_paths = list(dict.fromkeys(ignore_paths))

    # ignorePaths is non-mergeable. Keep it under force so repository config
    # detection cannot overwrite the generated old-version ignore list.
    config = {
        'requireConfig': 'ignored',
        'force': {
            'ignorePaths': ignore_paths
        }
    }

    OUTPUT_FILE.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8'
    )

    print(f'Wrote {OUTPUT_FILE}')
    print('Forced ignorePaths:')
    for ignore_path in ignore_paths:
        print(f'- {ignore_path}')


if __name__ == '__main__':
    main()

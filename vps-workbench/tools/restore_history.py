"""Verify or restore portable releases from the VPS Workbench history assets."""

import argparse
from contextlib import ExitStack, contextmanager
import hashlib
import json
from pathlib import Path
import re
import tempfile
import zipfile


CATALOG = "history-catalog.json"
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
ASSET = re.compile(r"history-objects-[0-9]{3}\.zip\Z")
DEVICE = re.compile(r"(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", re.IGNORECASE)
BUFFER = 1024 * 1024


def path_parts(name):
    parts = name.split("/")
    if any(part in ("", ".", "..") or part.endswith((".", " ")) or DEVICE.match(part) or
           re.search(r'[\x00-\x1f<>:"\\|?*]', part) for part in parts):
        raise ValueError(f"Invalid archive path: {name!r}")
    return parts


def verified_copy(source, digest, size, target=None):
    actual = hashlib.sha256()
    length = 0
    while chunk := source.read(BUFFER):
        length += len(chunk)
        if length > size:
            raise ValueError(f"Object exceeds declared size: {digest}")
        actual.update(chunk)
        if target is not None:
            target.write(chunk)
    if length != size or actual.hexdigest() != digest:
        raise ValueError(f"Object does not match its catalog entry: {digest}")


def load_catalog(directory):
    catalog = json.loads((directory / CATALOG).read_text(encoding="utf-8"))
    if catalog["schema"] != 1:
        raise ValueError("Unsupported history catalog")
    objects = catalog["objects"]
    for digest, item in objects.items():
        if not DIGEST.fullmatch(digest) or not ASSET.fullmatch(item["asset"]) or type(item["size"]) is not int or item["size"] < 0:
            raise ValueError("Invalid history object")
    items = catalog["items"]
    names = [item["name"].casefold() for item in items]
    if len(set(names)) != len(names):
        raise ValueError("Duplicate version names")
    used = set()
    for item in items:
        if len(path_parts(item["name"])) != 1:
            raise ValueError("A history item must have a single release name")
        if item["kind"] == "zip":
            used.add(item["object"])
            continue
        if item["kind"] not in ("release", "stage"):
            raise ValueError("Invalid history item type")
        normalized = set()
        for name in [*item["directories"], *item["files"]]:
            path_parts(name)
            if name.casefold() in normalized:
                raise ValueError("Duplicate files or directories")
            normalized.add(name.casefold())
        used.update(item["files"].values())
    if used != set(objects):
        raise ValueError("The history item set differs from the object index")
    return items, objects


@contextmanager
def open_objects(directory, objects):
    files = {}
    for digest, item in objects.items():
        files.setdefault(item["asset"], set()).add(digest)
    with ExitStack() as handles:
        readers = {}
        for asset, expected in files.items():
            archive = handles.enter_context(zipfile.ZipFile(directory / asset))
            names = archive.namelist()
            if set(names) != expected or len(names) != len(expected):
                raise ValueError(f"Object list does not match {asset}")
            readers[asset] = archive
        yield readers


def restore_item(directory, name, destination):
    items, objects = load_catalog(directory)
    item = next((item for item in items if item["name"] == name), None)
    if item is None:
        raise ValueError(f"No history item named {name}")
    destination = destination.resolve()
    if destination.exists():
        raise FileExistsError(destination)
    wanted = {item["object"]} if item["kind"] == "zip" else set(item["files"].values())
    wanted_assets = {objects[digest]["asset"] for digest in wanted}
    relevant = {digest: entry for digest, entry in objects.items() if entry["asset"] in wanted_assets}
    with tempfile.TemporaryDirectory(prefix=".workbench-restore-", dir=destination.parent) as scratch, open_objects(directory, relevant) as readers:
        target = Path(scratch) / "payload"

        def restore_file(path, digest):
            entry = objects[digest]
            with readers[entry["asset"]].open(digest) as source, path.open("xb") as output:
                verified_copy(source, digest, entry["size"], output)

        if item["kind"] == "zip":
            restore_file(target, item["object"])
        else:
            target.mkdir()
            for name in item["directories"]:
                target.joinpath(*path_parts(name)).mkdir(parents=True, exist_ok=True)
            for name, digest in item["files"].items():
                path = target.joinpath(*path_parts(name))
                path.parent.mkdir(parents=True, exist_ok=True)
                restore_file(path, digest)
        target.rename(destination)


def verify_archive(directory):
    items, objects = load_catalog(directory)
    with open_objects(directory, objects) as readers:
        for digest, entry in objects.items():
            with readers[entry["asset"]].open(digest) as source:
                verified_copy(source, digest, entry["size"])
    return len(items), len(objects)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path, help="Directory with the downloaded catalog and object ZIPs")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--list", action="store_true")
    action.add_argument("--verify", action="store_true")
    action.add_argument("--restore", nargs=2, metavar=("RELEASE_NAME", "DESTINATION"))
    args = parser.parse_args()
    if args.list:
        for item in load_catalog(args.assets)[0]:
            print(item["name"])
    elif args.verify:
        items, objects = verify_archive(args.assets)
        print(f"Verified {items} releases and original ZIPs, {objects} unique objects.")
    else:
        name, destination = args.restore
        restore_item(args.assets, name, Path(destination))
        print(f"Restored {destination}")


if __name__ == "__main__":
    main()

"""Read published stage files under the pinned SSH account's private archive."""
import base64
import contextlib
import hashlib
import os
from pathlib import Path
import stat
import uuid


def mount_id(fd):
    for line in Path("/proc/self/fdinfo", str(fd)).read_text().splitlines():
        if line.startswith("mnt_id:"):
            return int(line.split()[1])
    raise ValueError("mount identity unavailable")


def read_artifacts(workflow, home, task, query):
    if (str(uuid.UUID(task)) != task or not isinstance(query, dict)
            or set(query) not in (set(), {"after"}, {"path"}, {"path", "offset"})):
        raise ValueError("invalid artifact query")
    after = query.get("after")
    if "after" in query:
        workflow["parts"](after)
    offset = query.get("offset", 0)
    if type(offset) is not int or not 0 <= offset <= workflow["OUTPUT_BYTES"]:
        raise ValueError("invalid artifact offset")
    segments = workflow["parts"](query["path"]) if "path" in query else []
    opened = workflow["opened"]
    directory = os.O_DIRECTORY | os.O_RDONLY
    uid = os.getuid()
    with contextlib.ExitStack() as stack:
        parent = stack.enter_context(opened(home, directory))
        for name in (".remote-ssh-chat", "workflow-outputs", task):
            container_mount = mount_id(parent)
            parent = stack.enter_context(opened(name, directory, parent))
            info = os.fstat(parent)
            if info.st_uid != uid or info.st_mode & 0o077 or (name == task and mount_id(parent) != container_mount):
                raise ValueError("unsafe archive directory")
        boundary = mount_id(parent)

        def verify(fd):
            info = os.fstat(fd)
            if info.st_uid != uid or mount_id(fd) != boundary:
                raise ValueError("unsafe archive entry")
            return info

        if segments:
            for part in segments[:-1]:
                parent = stack.enter_context(opened(part, directory, parent))
                verify(parent)
            inode = stack.enter_context(opened(segments[-1], os.O_PATH, parent))
            info = verify(inode)
            chunked = "offset" in query
            max_size = workflow["OUTPUT_BYTES"] if chunked else 1024 * 1024
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > max_size
                    or offset != 0 and offset >= info.st_size):
                raise ValueError("invalid artifact preview")
            count = min(1024 * 1024, info.st_size - offset)
            with open("/proc/self/fd/" + str(inode), "rb") as stream:
                stream.seek(offset)
                data = stream.read(count)
            if len(data) != count or os.fstat(inode).st_ctime_ns != info.st_ctime_ns:
                raise ValueError("artifact changed")
            file = {"path": query["path"], "size": info.st_size, "data": base64.b64encode(data).decode("ascii")}
            if chunked:
                identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                file.update(offset=offset, revision=hashlib.sha256(repr(identity).encode("ascii")).hexdigest())
            return {"file": file}

        rows = []
        entries = 0
        def walk(fd, prefix):
            nonlocal entries
            with os.scandir(fd) as children:
                for child in children:
                    entries += 1
                    if entries > workflow["OUTPUT_ENTRIES"]:
                        raise ValueError("archive exceeds traversal limit")
                    path = "/".join((*prefix, child.name))
                    names = workflow["parts"](path)
                    if len(names) > 64:
                        raise ValueError("artifact path too deep")
                    with opened(child.name, os.O_PATH, fd) as item:
                        info = verify(item)
                        if stat.S_ISDIR(info.st_mode):
                            with workflow["open_directory_fd"](item) as nested:
                                walk(nested, names)
                        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                            rows.append({"path": path, "size": info.st_size})
        walk(parent, ())
        # UTF-16 ordinal order also matches Windows and JavaScript for supplementary characters.
        cursor = after.encode("utf-16-be") if after else b""
        rows = sorted((row for row in rows if row["path"].encode("utf-16-be") > cursor),
                      key=lambda row: row["path"].encode("utf-16-be"))
        return {"files": rows[:256], "truncated": len(rows) > 256}

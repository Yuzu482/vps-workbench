import errno
import grp
import pwd


def native_directory_safe(path, info):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o002:
        return False
    if not info.st_mode & 0o020:
        return True
    try:
        sources = {}
        with open("/etc/nsswitch.conf", encoding="utf-8") as stream:
            for line in stream:
                fields = line.split("#", 1)[0].split(":", 1)
                if len(fields) == 2 and fields[0].strip() in ("passwd", "group", "initgroups"):
                    name = fields[0].strip()
                    if name in sources: return False
                    sources[name] = fields[1].split()
        if any("files" not in sources.get(name, []) or any(x not in ("files", "systemd") for x in sources[name]) for name in ("passwd", "group")):
            return False
        if "initgroups" in sources and (not sources["initgroups"] or any(x not in ("files", "systemd") for x in sources["initgroups"])):
            return False
        me = pwd.getpwuid(os.getuid()); group = grp.getgrgid(info.st_gid)
        if info.st_gid != me.pw_gid or group.gr_name != me.pw_name or any(name != me.pw_name for name in group.gr_mem):
            return False
        if any(user.pw_gid == info.st_gid and user.pw_uid != os.getuid() for user in pwd.getpwall()):
            return False
        for attribute in ("system.posix_acl_access", "system.posix_acl_default"):
            try: os.getxattr(path, attribute); return False
            except OSError as error:
                if error.errno != errno.ENODATA: return False
        return True
    except (OSError, KeyError):
        return False

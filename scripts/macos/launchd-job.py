"""Read one user LaunchAgent as XML without parsing launchctl display text."""

import argparse
import ctypes
import sys


def copy_job(label: str) -> bytes:
    if sys.platform != "darwin":
        raise RuntimeError("LaunchAgent metadata requires macOS")
    cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    sm = ctypes.CDLL("/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement")
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    cf.CFRelease.restype = None
    sm.SMJobCopyDictionary.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    sm.SMJobCopyDictionary.restype = ctypes.c_void_p
    cf.CFPropertyListCreateData.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long,
                                           ctypes.c_ulong, ctypes.POINTER(ctypes.c_void_p)]
    cf.CFPropertyListCreateData.restype = ctypes.c_void_p
    cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
    cf.CFDataGetLength.restype = ctypes.c_long
    cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
    cf.CFDataGetBytePtr.restype = ctypes.c_void_p

    # The framework owns this constant; only Create/Copy results are released.
    domain = ctypes.c_void_p.in_dll(sm, "kSMDomainUserLaunchd")
    if not domain.value:
        raise RuntimeError("current user launchd domain is unavailable")
    references = []
    try:
        name = cf.CFStringCreateWithCString(None, label.encode("utf-8"), 0x08000100)
        if not name:
            raise RuntimeError("could not encode the LaunchAgent label")
        references.append(name)
        # This public API is deprecated but still supplies structured metadata;
        # current launchctl list no longer supports its former XML switch.
        job = sm.SMJobCopyDictionary(domain, name)
        if not job:
            raise RuntimeError("loaded LaunchAgent was not found in the current user domain")
        references.append(job)
        error = ctypes.c_void_p()
        data = cf.CFPropertyListCreateData(None, job, 100, 0, ctypes.byref(error))
        if error.value:
            references.append(error.value)
        if not data:
            raise RuntimeError("could not serialize loaded LaunchAgent metadata")
        references.append(data)
        length = cf.CFDataGetLength(data)
        pointer = cf.CFDataGetBytePtr(data)
        if length <= 0 or not pointer:
            raise RuntimeError("loaded LaunchAgent metadata was empty")
        return ctypes.string_at(pointer, length)
    finally:
        for reference in reversed(references):
            cf.CFRelease(reference)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("label")
    args = parser.parse_args()
    try:
        raw = copy_job(args.label)
    except (OSError, AttributeError, ValueError, RuntimeError) as exc:
        parser.exit(1, f"Error: cannot read loaded LaunchAgent: {exc}\n")
    sys.stdout.buffer.write(raw)


if __name__ == "__main__":
    main()

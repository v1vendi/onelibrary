"""Read and write the AlphaTheta / Pioneer DJ OneLibrary format.

The legacy DeviceSQL export it replaces (``export.pdb``) is readable too, via
:class:`onelibrary.pdb.PdbFile`, which offers the same surface as
:class:`OneLibraryDB` so a reader need not care which one a device carries.
"""

from onelibrary.db import OneLibraryDB, open_encrypted
from onelibrary.keys import KeyResolutionError, resolve_key
from onelibrary.pdb import PdbError, PdbFile

__version__ = "0.0.1"
__all__ = [
    "OneLibraryDB",
    "PdbError",
    "PdbFile",
    "open_encrypted",
    "resolve_key",
    "KeyResolutionError",
]

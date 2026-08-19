"""Default rows a OneLibrary device carries regardless of its content.

These are browse-UI configuration, not user data: the menu entries a
player offers, which categories and sort options are visible, and the
fixed colour palette. Captured verbatim from a rekordbox 7 export so a
generated device behaves like one rekordbox wrote.

``menuItem.name`` is wrapped in U+FFFA / U+FFFB -- Unicode's interlinear
annotation anchor and terminator. rekordbox uses them to mark a string the
*player* localises, so the device shows its own translation of ``GENRE``
rather than this ASCII. Reproduce the markers exactly; a writer that strips
them ships labels that will not localise.
"""

from __future__ import annotations

#: Browse menu entries: (menuItem_id, kind, name).
MENU_ITEMS: list[tuple[int, int, str]] = [
    (1, 128, '\ufffaGENRE\ufffb'),
    (2, 129, '\ufffaARTIST\ufffb'),
    (3, 130, '\ufffaALBUM\ufffb'),
    (4, 131, '\ufffaTRACK\ufffb'),
    (5, 133, '\ufffaBPM\ufffb'),
    (6, 134, '\ufffaRATING\ufffb'),
    (7, 135, '\ufffaYEAR\ufffb'),
    (8, 136, '\ufffaREMIXER\ufffb'),
    (9, 137, '\ufffaLABEL\ufffb'),
    (10, 138, '\ufffaORIGINAL ARTIST\ufffb'),
    (11, 139, '\ufffaKEY\ufffb'),
    (12, 141, '\ufffaCUE\ufffb'),
    (13, 142, '\ufffaCOLOR\ufffb'),
    (14, 146, '\ufffaTIME\ufffb'),
    (15, 147, '\ufffaBITRATE\ufffb'),
    (16, 148, '\ufffaFILE NAME\ufffb'),
    (17, 132, '\ufffaPLAYLIST\ufffb'),
    (18, 152, '\ufffaHOT CUE BANK\ufffb'),
    (19, 149, '\ufffaHISTORY\ufffb'),
    (20, 145, '\ufffaSEARCH\ufffb'),
    (21, 150, '\ufffaCOMMENTS\ufffb'),
    (22, 140, '\ufffaDATE ADDED\ufffb'),
    (23, 151, '\ufffaDJ PLAY COUNT\ufffb'),
    (24, 144, '\ufffaFOLDER\ufffb'),
    (25, 161, '\ufffaDEFAULT\ufffb'),
    (26, 162, '\ufffaALPHABET\ufffb'),
    (27, 170, '\ufffaMATCHING\ufffb'),
]

#: Browse categories: (category_id, menuItem_id, sequenceNo, isVisible).
CATEGORIES: list[tuple[int, int, int, int]] = [
    (1, 1, 0, 0),
    (2, 2, 1, 1),
    (3, 3, 2, 1),
    (4, 4, 3, 1),
    (5, 17, 5, 1),
    (6, 5, 0, 0),
    (7, 6, 0, 0),
    (8, 7, 0, 0),
    (9, 8, 0, 0),
    (10, 9, 0, 0),
    (11, 10, 0, 0),
    (12, 11, 4, 1),
    (15, 13, 0, 0),
    (17, 24, 9, 1),
    (18, 20, 7, 1),
    (19, 14, 0, 0),
    (20, 15, 0, 0),
    (21, 16, 0, 0),
    (22, 19, 6, 1),
    (23, 18, 0, 0),
    (26, 27, 8, 1),
    (27, 22, 10, 1),
]

#: Sort options: (sort_id, menuItem_id, sequenceNo, isVisible, isSelectedAsSubColumn).
SORT_OPTIONS: list[tuple[int, int, int, int, int]] = [
    (0, 25, 1, 1, 0),
    (1, 26, 2, 1, 0),
    (2, 2, 3, 1, 0),
    (3, 3, 4, 1, 0),
    (4, 5, 5, 1, 0),
    (5, 6, 6, 1, 0),
    (6, 1, 0, 0, 0),
    (7, 21, 0, 0, 0),
    (8, 14, 0, 0, 0),
    (9, 8, 0, 0, 0),
    (10, 9, 0, 0, 0),
    (11, 10, 0, 0, 0),
    (12, 11, 7, 1, 0),
    (13, 15, 0, 0, 0),
    (15, 13, 0, 0, 0),
    (16, 23, 0, 0, 0),
    (17, 22, 0, 0, 0),
]

#: The eight rekordbox track colours, always present in full.
COLORS: list[tuple[int, str]] = [
    (1, 'Pink'),
    (2, 'Red'),
    (3, 'Orange'),
    (4, 'Yellow'),
    (5, 'Green'),
    (6, 'Aqua'),
    (7, 'Blue'),
    (8, 'Dark'),
]

#: ``myTag.attribute``: 1 marks a folder, 0 a selectable tag.
MYTAG_FOLDER = 1
MYTAG_LEAF = 0

#: The four myTag folders rekordbox creates by default.
MYTAG_ROOTS: list[tuple[int, int, str]] = [
    (1, 0, 'Genre'),
    (2, 1, 'Components'),
    (3, 2, 'Situation'),
    (4, 3, 'Untitled Column'),
]

#: ``property.dbVersion`` written by rekordbox 7.
DB_VERSION = "1000"

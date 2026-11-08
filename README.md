# Quick Settings Manager

Reorder and manage GNOME Shell Quick Settings tiles and system-row controls.

## Features

- Drag or move Quick Settings elements with the arrow buttons.
- Set tiles to **Visible**, **Hidden** (revealed with Show more), or **Disabled**.
- Hide or show sliders and other grid elements.
- Add and reorder the user avatar, with independent visibility and size options.
- Show, hide, and reorder the controls in GNOME's system row, including any
  number of flexible spacers.
- Add a system-row Airplane Mode button and configure battery icon/percentage
  visibility.

The Airplane Mode system-row button starts hidden. Reset restores the default
element order and system-row settings while preserving the User Widget toggle.

## Compatibility

GNOME Shell 50. The GNOME Shell 51 source APIs were reviewed, but 51 is not
listed as supported until it is available for runtime testing.

## Development and packaging

Compile the settings schema after changing it:

```sh
glib-compile-schemas schemas/
```

Create an extension bundle with:

```sh
gnome-extensions pack --extra-source=README.md --extra-source=LICENSE .
```

The project is licensed under the MIT License; see `LICENSE`.

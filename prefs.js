// SPDX-License-Identifier: MIT
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.quick-settings-manager';
const SETTINGS_KEY_ORDER = 'element-order';
const SETTINGS_KEY_HIDDEN = 'hidden-elements';
const SETTINGS_KEY_AVAILABLE = 'available-elements';
const SETTINGS_KEY_DISABLED = 'disabled-elements';
const SETTINGS_KEY_TYPES = 'element-types';
const SETTINGS_KEY_AVATAR_SIZE = 'user-widget-avatar-size';
const SETTINGS_KEY_TEXT_SIZE = 'user-widget-text-size';
const SETTINGS_KEY_USER_WIDGET_ENABLED = 'user-widget-enabled';
const SETTINGS_KEY_SYSTEM_ITEMS_ORDER = 'system-items-order';
const SETTINGS_KEY_HIDDEN_SYSTEM_ITEMS = 'hidden-system-items';
const SETTINGS_KEY_BATTERY_SHOW_PERCENTAGE = 'battery-show-percentage';
const SETTINGS_KEY_BATTERY_SHOW_LOGO = 'battery-show-logo';
const SETTINGS_KEY_BATTERY_HIDE_ABOVE_ENABLED = 'battery-hide-above-enabled';
const SETTINGS_KEY_BATTERY_HIDE_ABOVE_THRESHOLD = 'battery-hide-above-threshold';
const SETTINGS_KEY_BATTERY_HIDE_PLUGGED_ENABLED = 'battery-hide-plugged-enabled';
const SETTINGS_KEY_BATTERY_HIDE_PLUGGED_THRESHOLD = 'battery-hide-plugged-threshold';

const SYSTEM_ITEM_IDS = [
    'PowerToggle', 'ScreenshotItem', 'SettingsItem', 'AirplaneModeItem',
    'LockItem', 'ShutdownItem',
];
const SYSTEM_ROW_DEFAULT_ORDER = [
    'PowerToggle', 'FlexibleSpacer#1', 'ScreenshotItem', 'SettingsItem',
    'AirplaneModeItem', 'LockItem', 'ShutdownItem',
];
const isSystemSpacerId = id => /^FlexibleSpacer#\d+$/.test(id);
const SYSTEM_ITEM_TITLES = {
    PowerToggle: 'Battery Indicator',
    ScreenshotItem: 'Screenshot',
    SettingsItem: 'Settings',
    AirplaneModeItem: 'Airplane Mode',
    LockItem: 'Lock Screen',
    ShutdownItem: 'Power Off Menu',
};

// Tile states in the drop-down (mirrors hidden/disabled settings)
const STATE_VISIBLE = 0;
const STATE_HIDDEN = 1;
const STATE_DISABLED = 2;

// Element kinds published for every grid element
const KIND_TILE = 'tile';
const KIND_SLIDER = 'slider';
const KIND_OTHER = 'other';

/**
 * QuickSettingsManagerPreferences - Preferences dialog for the extension
 */
export default class QuickSettingsManagerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings(SETTINGS_SCHEMA);
        this._settingsHandlers = [];
        this._refreshIdle = 0;
        this._systemItemsRefreshId = 0;
        window.connect('close-request', () => {
            this._cleanupPreferences();
            return false;
        });
        this._page = new Adw.PreferencesPage({
            title: _('Quick Settings Elements'),
        });
        window.add(this._page);
        const orderRows = this._getElementIds().length;
        window.set_default_size(900,
            Math.min(1500, Math.max(1000, orderRows * 54 + 420)));

        this._systemPage = new Adw.PreferencesPage({
            title: _('System Row Items'),
        });
        window.add(this._systemPage);
        
        this._group = new Adw.PreferencesGroup({title: _('Quick Settings Elements')});
        this._page.add(this._group);

        this._systemItemsGroup = new Adw.PreferencesGroup({
            title: _('System Row Items'),
            description: _('Show, hide, and reorder system-row controls. Add flexible spacers to position controls on either side.'),
        });
        this._systemPage.add(this._systemItemsGroup);
        this._systemItemRows = [];
        this._renderSystemItems();

        this._batteryGroup = new Adw.PreferencesGroup({
            title: _('Battery Indicator'),
            description: _('Control the battery icon and percentage shown in the system row.'),
        });
        this._systemPage.add(this._batteryGroup);
        const showPercentageRow = this._createSettingsSwitch(
            _('Show Percentage'),
            _('Show the battery percentage beside the icon'),
            SETTINGS_KEY_BATTERY_SHOW_PERCENTAGE);
        this._batteryGroup.add(showPercentageRow);
        this._batteryGroup.add(this._createSettingsSwitch(
            _('Show Battery Logo'),
            _('Show the battery icon'),
            SETTINGS_KEY_BATTERY_SHOW_LOGO));

        const hideAboveSwitch = this._createSettingsSwitch(
            _('Hide Percentage at Battery Level'),
            _('Hide the percentage at or above the selected level'),
            SETTINGS_KEY_BATTERY_HIDE_ABOVE_ENABLED);
        this._batteryGroup.add(hideAboveSwitch);
        const hideAboveThreshold = this._createSizeRow(
            _('Battery Level Threshold'),
            _('Percentage (0–100%)'),
            SETTINGS_KEY_BATTERY_HIDE_ABOVE_THRESHOLD, 0, 100);
        hideAboveThreshold.sensitive = this._settings.get_boolean(
            SETTINGS_KEY_BATTERY_HIDE_ABOVE_ENABLED);
        this._batteryGroup.add(hideAboveThreshold);

        const hidePluggedSwitch = this._createSettingsSwitch(
            _('Hide Percentage When Plugged In'),
            _('Hide at or above the selected level while charging or fully charged'),
            SETTINGS_KEY_BATTERY_HIDE_PLUGGED_ENABLED);
        this._batteryGroup.add(hidePluggedSwitch);
        const hidePluggedThreshold = this._createSizeRow(
            _('Plugged-In Level Threshold'),
            _('Percentage (0–100%)'),
            SETTINGS_KEY_BATTERY_HIDE_PLUGGED_THRESHOLD, 0, 100);
        hidePluggedThreshold.sensitive = this._settings.get_boolean(
            SETTINGS_KEY_BATTERY_HIDE_PLUGGED_ENABLED);
        this._batteryGroup.add(hidePluggedThreshold);

        const syncPercentageOptions = () => {
            const percentageVisible = showPercentageRow._qsmToggle.active;
            hideAboveSwitch.sensitive = percentageVisible;
            hideAboveThreshold.sensitive = percentageVisible &&
                hideAboveSwitch._qsmToggle.active;
            hidePluggedSwitch.sensitive = percentageVisible;
            hidePluggedThreshold.sensitive = percentageVisible &&
                hidePluggedSwitch._qsmToggle.active;
        };
        showPercentageRow._qsmToggle.connect('notify::active',
            syncPercentageOptions);
        hideAboveSwitch._qsmToggle.connect('notify::active',
            syncPercentageOptions);
        hidePluggedSwitch._qsmToggle.connect('notify::active',
            syncPercentageOptions);
        syncPercentageOptions();
        
        // User widget settings
        this._userWidgetGroup = new Adw.PreferencesGroup({
            title: _('User Widget'),
            description: _('Appearance of the avatar row in the quick settings menu'),
        });
        this._page.add(this._userWidgetGroup);

        // User widget visibility toggle
        this._userWidgetGroup.add(this._createSwitch(
            _('Show User Widget'),
            _('Toggle to show/hide the user avatar'),
            this._settings.get_boolean(SETTINGS_KEY_USER_WIDGET_ENABLED)
        ));
        
        this._userWidgetGroup.add(this._createSizeRow(
            _('Profile Picture Size'),
            _('Size of the avatar picture in pixels'),
            SETTINGS_KEY_AVATAR_SIZE, 16, 256));
        this._userWidgetGroup.add(this._createSizeRow(
            _('Text Size'),
            _('Size of the user name text in pixels'),
            SETTINGS_KEY_TEXT_SIZE, 8, 64));

        // One-time CSS for the drag-and-drop indicators
        this._ensureCss();
        
        // Refresh the list when the extension publishes menu contents
        this._connectSetting(SETTINGS_KEY_AVAILABLE,
            () => this._scheduleRefresh());
        this._connectSetting(SETTINGS_KEY_ORDER,
            () => this._scheduleRefresh());
        this._connectSetting(SETTINGS_KEY_TYPES,
            () => this._scheduleRefresh());
        this._connectSetting(SETTINGS_KEY_SYSTEM_ITEMS_ORDER,
            () => this._scheduleSystemItemsRefresh());
        this._connectSetting(SETTINGS_KEY_HIDDEN_SYSTEM_ITEMS,
            () => this._scheduleSystemItemsRefresh());
        
        // Get current quick settings elements
        this._refreshElements();
    }
    
    /**
     * Register the CSS used to indicate drag-and-drop targets. Colors are
     * the standard GNOME blue so the indicator is visible in any theme.
     */
    _ensureCss() {
        if (this._cssAdded)
            return;
        try {
            this._cssDisplay = Gdk.Display.get_default();
            if (!this._cssDisplay)
                return;
            const provider = new Gtk.CssProvider();
            const css = `
                .qsm-drop-target { background-color: rgba(53, 132, 228, 0.25); }
                .qsm-drop-before { box-shadow: inset 0 2px 0 0 #3584e4; }
                .qsm-drop-after { box-shadow: inset 0 -2px 0 0 #3584e4; }
            `;
            try {
                provider.load_from_string(css);
            } catch (e) {
                provider.load_from_data(css, css.length);
            }
            Gtk.StyleContext.add_provider_for_display(
                this._cssDisplay, provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
            this._cssProvider = provider;
            this._cssAdded = true;
        } catch (e) {
            // The highlight is purely cosmetic — ignore styling failures
        }
    }
    
    _dragHandleIcon() {
        if (this._handleIcon)
            return this._handleIcon;
        this._handleIcon = 'open-menu-symbolic';
        try {
            const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
            if (theme.has_icon('list-drag-handle-symbolic'))
                this._handleIcon = 'list-drag-handle-symbolic';
        } catch (e) {
            // Keep the fallback icon
        }
        return this._handleIcon;
    }
    
    _getAvailable() {
        try {
            // deep_unpack() is required: unpack() on a{ss} leaves the
            // string values as empty objects
            const value = this._settings.get_value(SETTINGS_KEY_AVAILABLE);
            const unpacked = typeof value.deep_unpack === 'function'
                ? value.deep_unpack()
                : value.unpack();
            return unpacked ?? {};
        } catch (e) {
            return {};
        }
    }
    
    _getTypes() {
        try {
            const value = this._settings.get_value(SETTINGS_KEY_TYPES);
            const unpacked = typeof value.deep_unpack === 'function'
                ? value.deep_unpack()
                : value.unpack();
            return unpacked ?? {};
        } catch (e) {
            return {};
        }
    }

    _getSystemItemIds() {
        const saved = this._settings.get_strv(SETTINGS_KEY_SYSTEM_ITEMS_ORDER);
        const ids = [];
        for (let id of saved) {
            if (id === 'FlexibleSpacer')
                id = 'FlexibleSpacer#1';
            if ((SYSTEM_ITEM_IDS.includes(id) || isSystemSpacerId(id)) &&
                !ids.includes(id))
                ids.push(id);
        }
        for (const id of SYSTEM_ITEM_IDS) {
            if (!ids.includes(id))
                ids.push(id);
        }
        if (ids.length !== saved.length || ids.some((id, i) => id !== saved[i]))
            this._settings.set_strv(SETTINGS_KEY_SYSTEM_ITEMS_ORDER, ids);
        return ids;
    }

    _renderSystemItems() {
        for (const row of this._systemItemRows)
            this._systemItemsGroup.remove(row);
        this._systemItemRows = [];

        const ids = this._getSystemItemIds();
        const hidden = new Set(this._settings.get_strv(
            SETTINGS_KEY_HIDDEN_SYSTEM_ITEMS));

        ids.forEach((id, index) => {
            const isSpacer = isSystemSpacerId(id);
            const spacerNumber = isSpacer ? id.match(/#(\d+)$/)?.[1] : null;
            const row = new Adw.ActionRow({
                title: isSpacer
                    ? `${_('Flexible Spacer')} ${spacerNumber}`
                    : _(SYSTEM_ITEM_TITLES[id] ?? this._formatElementName(id)),
                subtitle: isSpacer
                    ? _('Moves following controls to the other side') : id,
            });
            row.add_prefix(new Gtk.Image({icon_name: this._dragHandleIcon()}));

            const dragSource = new Gtk.DragSource({
                actions: Gdk.DragAction.MOVE,
            });
            dragSource.connect('prepare', () =>
                Gdk.ContentProvider.new_for_value(id));
            row.add_controller(dragSource);

            const dropTarget = Gtk.DropTarget.new(
                GObject.TYPE_STRING, Gdk.DragAction.MOVE);
            dropTarget.connect('accept', (_target, value) =>
                this._coerceDropValue(value) !== id);
            dropTarget.connect('drop', (_target, value, _x, y) => {
                const sourceId = this._coerceDropValue(value);
                if (sourceId && sourceId !== id)
                    this._reorderSystemItems(sourceId, id,
                        y >= row.get_height() / 2);
                return true;
            });
            row.add_controller(dropTarget);

            const upButton = new Gtk.Button({
                icon_name: 'pan-up-symbolic',
                tooltip_text: _('Move up'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                sensitive: index > 0,
            });
            upButton.connect('clicked', () => this._moveSystemItem(id, -1));
            row.add_suffix(upButton);

            const downButton = new Gtk.Button({
                icon_name: 'pan-down-symbolic',
                tooltip_text: _('Move down'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                sensitive: index < ids.length - 1,
            });
            downButton.connect('clicked', () => this._moveSystemItem(id, 1));
            row.add_suffix(downButton);

            if (!isSpacer) {
                const showSwitch = new Gtk.Switch({
                    active: !hidden.has(id),
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Show in the system row'),
                });
                showSwitch.connect('notify::active', sw => {
                    const current = new Set(this._settings.get_strv(
                        SETTINGS_KEY_HIDDEN_SYSTEM_ITEMS));
                    if (sw.active)
                        current.delete(id);
                    else
                        current.add(id);
                    this._settings.set_strv(SETTINGS_KEY_HIDDEN_SYSTEM_ITEMS,
                        [...current]);
                });
                row.add_suffix(showSwitch);
            } else {
                const removeButton = new Gtk.Button({
                    icon_name: 'list-remove-symbolic',
                    tooltip_text: _('Remove spacer'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                removeButton.connect('clicked', () =>
                    this._removeSystemSpacer(id));
                row.add_suffix(removeButton);
            }

            this._systemItemsGroup.add(row);
            this._systemItemRows.push(row);
        });

        const addRow = new Adw.ActionRow({
            title: _('Add Flexible Spacer'),
            subtitle: _('Add another divider to move controls between sides'),
        });
        const addButton = new Gtk.Button({
            label: _('Add'),
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this._addSystemSpacer());
        addRow.add_suffix(addButton);
        addRow.activatable_widget = addButton;
        this._systemItemsGroup.add(addRow);
        this._systemItemRows.push(addRow);
    }

    _addSystemSpacer() {
        const ids = this._getSystemItemIds();
        let number = 1;
        while (ids.includes(`FlexibleSpacer#${number}`))
            number++;
        let index = ids.indexOf('LockItem');
        if (index < 0)
            index = ids.length;
        ids.splice(index, 0, `FlexibleSpacer#${number}`);
        this._settings.set_strv(SETTINGS_KEY_SYSTEM_ITEMS_ORDER, ids);
        this._scheduleSystemItemsRefresh();
    }

    _removeSystemSpacer(spacerId) {
        const ids = this._getSystemItemIds().filter(id => id !== spacerId);
        this._settings.set_strv(SETTINGS_KEY_SYSTEM_ITEMS_ORDER, ids);
        this._scheduleSystemItemsRefresh();
    }

    _scheduleSystemItemsRefresh() {
        if (this._systemItemsRefreshId)
            return;
        this._systemItemsRefreshId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._systemItemsRefreshId = 0;
                try {
                    this._renderSystemItems();
                } catch (e) {
                    // The preferences window may have been closed.
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    _reorderSystemItems(sourceId, targetId, placeAfter = false) {
        const ids = this._getSystemItemIds();
        const sourceIndex = ids.indexOf(sourceId);
        const targetIndex = ids.indexOf(targetId);
        if (sourceIndex < 0 || targetIndex < 0 || sourceId === targetId)
            return;
        ids.splice(sourceIndex, 1);
        let insertIndex = ids.indexOf(targetId);
        if (placeAfter)
            insertIndex++;
        ids.splice(insertIndex, 0, sourceId);
        this._settings.set_strv(SETTINGS_KEY_SYSTEM_ITEMS_ORDER, ids);
        this._scheduleSystemItemsRefresh();
    }

    _moveSystemItem(id, delta) {
        const ids = this._getSystemItemIds();
        const index = ids.indexOf(id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= ids.length)
            return;
        ids.splice(index, 1);
        ids.splice(target, 0, id);
        this._settings.set_strv(SETTINGS_KEY_SYSTEM_ITEMS_ORDER, ids);
        this._scheduleSystemItemsRefresh();
    }
    
    /**
     * Whether an element is a quick tile (three states), a slider or
     * anything else (simple show/hide switch). Uses the kind published by
     * the extension, falling back to known ids before it has published.
     */
    _kindOf(elementId, types) {
        const published = types?.[elementId];
        if (published === 'tile' || published === 'slider' || published === 'other')
            return published;
        if (elementId === 'SystemItem' || elementId === 'BackgroundAppsToggle' ||
            elementId === 'UserWidget')
            return 'other';
        if (elementId === 'BrightnessItem' || elementId.endsWith('Slider'))
            return 'slider';
        return 'tile';
    }
    
    _refreshElements() {
        // Remove previously added children from the group
        if (this._desc) {
            this._group.remove(this._desc);
            this._desc = null;
        }
        if (this._listBox) {
            this._group.remove(this._listBox);
            this._listBox = null;
        }
        
        // Add description
        this._desc = new Gtk.Label({
            label: _('Drag rows or use the arrows to reorder. Tiles can be ' +
                'Visible, Hidden (revealed by the Show more button) or ' +
                'Disabled (never shown). Switches fully hide other ' +
                'elements; the user avatar has a separate visibility toggle.'),
            xalign: 0,
            wrap: true
        });
        this._group.add(this._desc);
        
        // Let the preferences page, rather than a small nested scroller,
        // provide scrolling so the ordering list can use the full window.
        this._listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        this._group.add(this._listBox);
        
        // Build the element list: saved order first, then any newly
        // discovered elements the extension published
        const hidden = this._settings.get_strv(SETTINGS_KEY_HIDDEN);
        const hiddenSet = new Set(hidden);
        const disabledSet = new Set(this._settings.get_strv(SETTINGS_KEY_DISABLED));
        const available = this._getAvailable();
        const types = this._getTypes();
        
        this._populateList(this._listBox, this._getElementIds(),
            hiddenSet, disabledSet, available, types);
    }
    
    /**
     * The exact list shown in the UI: saved order first, then elements
     * discovered by the extension, falling back to the built-in defaults
     * before the extension has published anything.
     */
    _getElementIds() {
        const order = this._settings.get_strv(SETTINGS_KEY_ORDER);
        const available = this._getAvailable();
        const availableIds = Object.keys(available);
        
        // When the extension has published the real menu contents, drop
        // stale saved ids that no longer exist (e.g. the bogus defaults
        // written by older versions of this extension)
        const ids = availableIds.length > 0
            ? order.filter(id => id in available)
            : [...order];

        // The avatar is a built-in, always-orderable entry. Its visibility
        // is controlled separately and does not affect this list.
        if (!ids.includes('UserWidget'))
            ids.unshift('UserWidget');

        const known = new Set(ids);
        for (const id of availableIds) {
            if (!known.has(id))
                ids.push(id);
        }

        if (ids.length === 0)
            ids.push(...this._getDefaultOrder());

        return ids;
    }
    
    _getDefaultOrder() {
        // Fallback list used only until the extension publishes the real
        // contents of the quick settings menu (ids are constructor names)
        return [
            'UserWidget',
            'NMToggle',
            'BluetoothToggle',
            'BrightnessItem',
            'StreamSlider',
            'NightLightToggle',
            'RotationToggle',
            'RfkillToggle',
            'DarkModeToggle',
            'DoNotDisturbToggle',
            'PowerProfilesToggle',
            'KeyboardBrightnessToggle',
        ];
    }
    
    _populateList(listBox, order, hiddenSet, disabledSet, available, types) {
        // Clear list
        while (listBox.get_first_child()) {
            listBox.remove(listBox.get_first_child());
        }
        
        // Create a row for each element
        for (let i = 0; i < order.length; i++) {
            const elementId = order[i];
            const raw = available?.[elementId];
            const title = typeof raw === 'string' ? raw : '';
            const row = this._createElementRow(
                elementId, hiddenSet.has(elementId),
                disabledSet.has(elementId), title,
                i > 0, i < order.length - 1,
                this._kindOf(elementId, types));
            listBox.append(row);
        }
        
        // Add button to refresh from actual menu
        const refreshRow = new Adw.ActionRow({
            title: _('Refresh from Current Menu'),
            subtitle: _('Scan the quick settings menu for current elements')
        });
        
        const refreshBtn = new Gtk.Button({
            label: _('Refresh'),
            valign: Gtk.Align.CENTER
        });
        refreshBtn.connect('clicked', () => {
            this._refreshFromMenu();
        });
        refreshRow.add_suffix(refreshBtn);
        refreshRow.activatable_widget = refreshBtn;
        listBox.append(refreshRow);
        
        // Add reset button
        const resetRow = new Adw.ActionRow({
            title: _('Reset to Default'),
            subtitle: _('Restore default order and visibility (keeps User Widget setting)')
        });
        
        const resetBtn = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER
        });
        resetBtn.connect('clicked', () => {
            this._resetToDefault();
        });
        resetRow.add_suffix(resetBtn);
        resetRow.activatable_widget = resetBtn;
        listBox.append(resetRow);
    }
    
    _createElementRow(elementId, isHidden, isDisabled, title,
        canMoveUp, canMoveDown, kind) {
        const row = new Adw.ActionRow({
            title: title || this._formatElementName(elementId),
            subtitle: elementId
        });
        
        // Drag handle: visual cue that the row is draggable (the whole
        // row accepts drags, not just the handle)
        row.add_prefix(new Gtk.Image({icon_name: this._dragHandleIcon()}));
        
        // Drag source: dragging this row carries its element id
        const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        dragSource.connect('prepare', () =>
            Gdk.ContentProvider.new_for_value(elementId));
        row.add_controller(dragSource);
        
        // Drop target: dropping another row's id here reorders the list.
        // The pointer's half of the row decides whether the dragged item
        // lands before or after this row (edge line shows which).
        const dropTarget = Gtk.DropTarget.new(
            GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        const clearHighlight = () => {
            row.remove_css_class('qsm-drop-target');
            row.remove_css_class('qsm-drop-before');
            row.remove_css_class('qsm-drop-after');
        };
        const pointerIsAfter = y => y >= row.get_height() / 2;
        dropTarget.connect('accept', (_dt, value) =>
            this._coerceDropValue(value) !== elementId);
        dropTarget.connect('enter', () => {
            row.add_css_class('qsm-drop-target');
            return Gdk.DragAction.MOVE;
        });
        dropTarget.connect('motion', (_dt, _x, y) => {
            row.remove_css_class('qsm-drop-before');
            row.remove_css_class('qsm-drop-after');
            row.add_css_class(pointerIsAfter(y)
                ? 'qsm-drop-after' : 'qsm-drop-before');
            return Gdk.DragAction.MOVE;
        });
        dropTarget.connect('leave', clearHighlight);
        dropTarget.connect('drop', (_dt, value, _x, y) => {
            const sourceId = this._coerceDropValue(value);
            if (sourceId && sourceId !== elementId)
                this._reorderElements(sourceId, elementId, pointerIsAfter(y));
            clearHighlight();
            return true;
        });
        row.add_controller(dropTarget);
        
        // Up/down buttons for precise single-step reordering; greyed out
        // at the ends of the list
        const upBtn = new Gtk.Button({
            icon_name: 'pan-up-symbolic',
            tooltip_text: _('Move up'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            sensitive: canMoveUp,
        });
        upBtn.connect('clicked', () => this._moveElement(elementId, -1));
        row.add_suffix(upBtn);
        
        const downBtn = new Gtk.Button({
            icon_name: 'pan-down-symbolic',
            tooltip_text: _('Move down'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            sensitive: canMoveDown,
        });
        downBtn.connect('clicked', () => this._moveElement(elementId, 1));
        row.add_suffix(downBtn);
        
        // Tiles get the three-state drop-down. Sliders and other elements
        // get a simple show/hide switch; UserWidget has its own toggle above.
        if (kind === 'tile') {
            const state = isDisabled ? STATE_DISABLED
                : (isHidden ? STATE_HIDDEN : STATE_VISIBLE);
            const stateDrop = new Gtk.DropDown({
                model: Gtk.StringList.new([
                    _('Visible'),
                    _('Hidden'),
                    _('Disabled'),
                ]),
                selected: state,
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Visible: always shown. Hidden: revealed ' +
                    'by the Show more button. Disabled: never shown.'),
            });
            stateDrop.connect('notify::selected', dd => {
                this._setTileState(elementId, dd.selected);
            });
            row.add_suffix(stateDrop);
            row.activatable_widget = stateDrop;
        } else if (kind !== KIND_TILE && elementId !== 'UserWidget') {
            const switchWidget = new Gtk.Switch({
                active: !isHidden,
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Show in quick settings'),
            });
            switchWidget.connect('notify::active', (sw) => {
                this._toggleElementVisibility(elementId, sw.active);
            });
            row.add_suffix(switchWidget);
            row.activatable_widget = switchWidget;
        }
        // User Widget: no switch here — visibility is handled by its own
        // toggle in the User Widget group above
        
        return row;
    }
    
    _formatElementName(id) {
        // Convert PascalCase/CamelCase to a readable name, keeping
        // consecutive capitals (acronyms like "NM") together
        return id
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .replace(/([a-z\d])([A-Z])/g, '$1 $2')
            .replace(/^./, str => str.toUpperCase())
            .trim();
    }
    
    _toggleElementVisibility(elementId, visible) {
        const hidden = this._settings.get_strv(SETTINGS_KEY_HIDDEN);
        const hiddenSet = new Set(hidden);
        
        if (visible) {
            hiddenSet.delete(elementId);
        } else {
            hiddenSet.add(elementId);
        }
        
        this._settings.set_strv(SETTINGS_KEY_HIDDEN, Array.from(hiddenSet));
    }
    
    /**
     * Set a tile to visible (0), hidden (1) or disabled (2). Hidden tiles
     * live in hidden-elements (revealed by the Show more button), disabled
     * ones in disabled-elements (never shown).
     */
    _setTileState(elementId, state) {
        const hidden = new Set(this._settings.get_strv(SETTINGS_KEY_HIDDEN));
        const disabled = new Set(this._settings.get_strv(SETTINGS_KEY_DISABLED));
        
        hidden.delete(elementId);
        disabled.delete(elementId);
        if (state === STATE_HIDDEN) {
            hidden.add(elementId);
        } else if (state === STATE_DISABLED) {
            disabled.add(elementId);
        }
        
        this._settings.set_strv(SETTINGS_KEY_HIDDEN, Array.from(hidden));
        this._settings.set_strv(SETTINGS_KEY_DISABLED, Array.from(disabled));
    }
    
    /**
     * The 'drop' signal's value param may arrive as a plain JS string or
     * as a GLib.Value wrapper depending on GJS marshalling — handle both.
     */
    _coerceDropValue(value) {
        if (typeof value === 'string')
            return value;
        if (value && typeof value.unpack === 'function') {
            const unpacked = value.unpack();
            return typeof unpacked === 'string' ? unpacked : null;
        }
        if (value && typeof value.get_string === 'function')
            return value.get_string();
        return null;
    }
    
    /**
     * Rebuild the list on the next idle turn instead of immediately:
     * reorder/reset run inside widget signal handlers (drop, clicked) and
     * must not destroy the very widget that is emitting the signal.
     */
    _scheduleRefresh() {
        if (this._refreshIdle)
            return;
        this._refreshIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshIdle = 0;
            try {
                this._refreshElements();
            } catch (e) {
                // Window was closed before the idle ran
            }
            return GLib.SOURCE_REMOVE;
        });
    }
    
    /**
     * Move sourceId next to targetId. placeAfter=false lands the source
     * immediately before the target, true lands it immediately after.
     * (The target's index is re-looked-up after removing the source so
     * both directions compute correctly.)
     */
    _reorderElements(sourceId, targetId, placeAfter = false) {
        // Reorder the exact list shown in the UI, not just the saved order
        const effective = this._getElementIds();
        
        if (sourceId === targetId) return;
        const sourceIndex = effective.indexOf(sourceId);
        const targetIndex = effective.indexOf(targetId);
        if (sourceIndex === -1 || targetIndex === -1) return;
        
        effective.splice(sourceIndex, 1);
        let insertIndex = effective.indexOf(targetId);
        if (insertIndex === -1) return;
        if (placeAfter) insertIndex++;
        effective.splice(insertIndex, 0, sourceId);
        
        this._settings.set_strv(SETTINGS_KEY_ORDER, effective);
        
        // Refresh the list to reflect new order (deferred: we are inside
        // the drop handler of a row that the rebuild would destroy)
        this._scheduleRefresh();
    }
    
    /** Move an element one position up (delta -1) or down (delta +1). */
    _moveElement(elementId, delta) {
        const ids = this._getElementIds();
        const index = ids.indexOf(elementId);
        if (index === -1) return;
        const dest = index + delta;
        if (dest < 0 || dest >= ids.length) return;
        
        ids.splice(index, 1);
        ids.splice(dest, 0, elementId);
        this._settings.set_strv(SETTINGS_KEY_ORDER, ids);
        this._scheduleRefresh();
    }
    
    _refreshFromMenu() {
        // The extension publishes the current menu contents to the
        // available-elements setting (and prefs refreshes on changes),
        // so re-reading the settings is all we can do from this process.
        // Deferred so we don't destroy the button mid-'clicked'.
        this._scheduleRefresh();
    }
    
    /**
     * Spin row bound to an integer settings key: edits write through to
     * the settings immediately, external changes update the row.
     */
    _createSizeRow(title, subtitle, key, lower, upper) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: 1,
                page_increment: 10,
                value: this._settings.get_int(key),
            }),
        });
        row.connect('notify::value', () => {
            const value = Math.round(row.value);
            if (this._settings.get_int(key) !== value)
                this._settings.set_int(key, value);
        });
        this._connectSetting(key, () => {
            const value = this._settings.get_int(key);
            if (Math.round(row.value) !== value)
                row.value = value;
        });
        return row;
    }

    _createSwitch(title, subtitle, isActive) {
        const row = new Adw.ActionRow({
            title,
            subtitle,
        });
        const switchWidget = new Gtk.Switch({
            active: isActive,
            valign: Gtk.Align.CENTER,
        });
        switchWidget.connect('notify::active', (sw) => {
            this._toggleUserWidgetVisibility(sw.active);
        });
        this._connectSetting(SETTINGS_KEY_USER_WIDGET_ENABLED, () => {
            const active = this._settings.get_boolean(
                SETTINGS_KEY_USER_WIDGET_ENABLED);
            if (switchWidget.active !== active)
                switchWidget.active = active;
        });
        row._qsmToggle = switchWidget;
        row.add_suffix(switchWidget);
        row.activatable_widget = switchWidget;
        return row;
    }

    _createSettingsSwitch(title, subtitle, key) {
        const row = new Adw.ActionRow({title, subtitle});
        const switchWidget = new Gtk.Switch({
            active: this._settings.get_boolean(key),
            valign: Gtk.Align.CENTER,
        });
        switchWidget.connect('notify::active', sw =>
            this._settings.set_boolean(key, sw.active));
        this._connectSetting(key, () => {
            const active = this._settings.get_boolean(key);
            if (switchWidget.active !== active)
                switchWidget.active = active;
        });
        row.add_suffix(switchWidget);
        row.activatable_widget = switchWidget;
        row._qsmToggle = switchWidget;
        return row;
    }

    _toggleUserWidgetVisibility(visible) {
        this._settings.set_boolean(SETTINGS_KEY_USER_WIDGET_ENABLED, visible);
    }

    _connectSetting(key, callback) {
        const id = this._settings.connect(`changed::${key}`, callback);
        this._settingsHandlers.push(id);
        return id;
    }

    _cleanupPreferences() {
        for (const id of this._settingsHandlers ?? []) {
            try {
                this._settings?.disconnect(id);
            } catch (e) {
                // The settings object may already be disposed.
            }
        }
        this._settingsHandlers = [];

        for (const sourceId of [this._refreshIdle,
            this._systemItemsRefreshId]) {
            if (sourceId)
                GLib.Source.remove(sourceId);
        }
        this._refreshIdle = 0;
        this._systemItemsRefreshId = 0;

        if (this._cssProvider && this._cssDisplay) {
            Gtk.StyleContext.remove_provider_for_display(
                this._cssDisplay, this._cssProvider);
        }
        this._cssProvider = null;
        this._cssDisplay = null;
        this._cssAdded = false;
        this._settings = null;
        this._window = null;
    }

    _resetToDefault() {
        // Restore default element states while preserving the independent
        // User Widget setting.
        const available = this._getAvailable();
        const availableIds = Object.keys(available)
            .filter(id => id !== 'UserWidget');
        availableIds.unshift('UserWidget');
        this._settings.set_strv(SETTINGS_KEY_ORDER,
            availableIds.length > 0 ? availableIds : this._getDefaultOrder());
        this._settings.set_strv(SETTINGS_KEY_HIDDEN, []);
        this._settings.set_strv(SETTINGS_KEY_DISABLED, []);
        this._settings.set_strv(SETTINGS_KEY_SYSTEM_ITEMS_ORDER,
            [...SYSTEM_ROW_DEFAULT_ORDER]);
        this._settings.set_strv(SETTINGS_KEY_HIDDEN_SYSTEM_ITEMS,
            ['AirplaneModeItem']);
        this._settings.set_boolean(SETTINGS_KEY_BATTERY_SHOW_PERCENTAGE, true);
        this._settings.set_boolean(SETTINGS_KEY_BATTERY_SHOW_LOGO, true);
        this._settings.set_boolean(SETTINGS_KEY_BATTERY_HIDE_ABOVE_ENABLED, false);
        this._settings.set_int(SETTINGS_KEY_BATTERY_HIDE_ABOVE_THRESHOLD, 80);
        this._settings.set_boolean(SETTINGS_KEY_BATTERY_HIDE_PLUGGED_ENABLED, false);
        this._settings.set_int(SETTINGS_KEY_BATTERY_HIDE_PLUGGED_THRESHOLD, 80);
        this._scheduleSystemItemsRefresh();
        // Deferred: the reset button would otherwise be destroyed while
        // its own 'clicked' handler is on the stack
        this._scheduleRefresh();
    }

}

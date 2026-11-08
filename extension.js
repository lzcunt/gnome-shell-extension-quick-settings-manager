// SPDX-License-Identifier: MIT
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSettingsItem, QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';
import * as Rfkill from 'resource:///org/gnome/shell/ui/status/rfkill.js';
import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

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

const SYSTEM_ROW_IDS = [
    'PowerToggle',
    'ScreenshotItem',
    'SettingsItem',
    'AirplaneModeItem',
    'LockItem',
    'ShutdownItem',
];
const isSystemSpacerId = id => /^FlexibleSpacer#\d+$/.test(id);

// Kind values published for every grid element
const KIND_TILE = 'tile';
const KIND_SLIDER = 'slider';
const KIND_OTHER = 'other';

/**
 * QuickSettingsManager - GNOME Shell extension to reorder and hide quick
 * settings items (toggles, menu toggles and sliders in the QS grid).
 *
 * Tile elements have three states:
 *   - visible: always shown
 *   - hidden:  revealed by the expand button below the tiles
 *   - disabled: never shown
 * Sliders and other grid elements use a show/hide switch. User Widget
 * visibility and SystemItem children are configured separately.
 *
 * The user widget (avatar + user name) is created by this extension,
 * controlled by its own persistent setting, and always available to reorder.
 */
export default class QuickSettingsManagerExtension extends Extension {
    enable() {
        this._avatarStylesheet = this.dir.get_child('stylesheet.css');
        try {
            St.ThemeContext.get_for_stage(global.stage).get_theme()
                .load_stylesheet(this._avatarStylesheet);
        } catch (e) {
            logError(e, 'Quick Settings Manager: failed to load user widget style');
            this._avatarStylesheet = null;
        }
        this._settings = this.getSettings(SETTINGS_SCHEMA);
        this._handlers = [];
        this._menu = null;
        this._grid = null;
        this._expandBtn = null;
        this._expandLabel = null;
        this._expandIcon = null;
        this._userWidget = null;
        this._userWidgetRetryId = null;
        this._systemMenu = null;
        this._systemMenuOriginalConstraint = null;
        this._systemMenuHeightBinding = null;
        this._systemRow = null;
        this._systemRowContainer = null;
        this._systemRowOriginalChildren = null;
        this._systemRowItems = new Map();
        this._systemRowSpacers = new Map();
        this._systemRowNativeVisibility = new Map();
        this._airplaneModeItem = null;
        this._rfkillManager = null;
        this._applyingSystemRowSettings = false;
        this._batteryOriginalState = null;
        this._destroyId = null;
        this._originalOrder = null;
        this._hiddenByUs = new Set();
        this._visibilityWatched = new Set();
        this._applying = false;
        this._expanded = false;

        // Wait for the quick settings menu to be available
        this._initQuickSettings();
    }

    _initQuickSettings() {
        const quickSettingsButton = Main.panel.statusArea.quickSettings;
        const menu = quickSettingsButton?.menu;
        if (!menu?._grid) {
            // Retry after a short delay
            this._destroyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._destroyId = null;
                this._initQuickSettings();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        this._menu = menu;
        this._grid = menu._grid;
        this._originalOrder = this._grid.get_children();

        // The user widget (avatar + user name) as the first grid row.
        // Create it first so it is part of the stock children captured
        // below, which feeds available-elements and makes the widget
        // appear in prefs even when disabled.
        this._createUserWidget();

        // The avatar's visibility has its own setting, never hidden-elements
        // or disabled-elements. Keep it in element-order regardless of state.
        const savedOrder = this._settings.get_strv(SETTINGS_KEY_ORDER);
        if (!savedOrder.includes('UserWidget')) {
            savedOrder.unshift('UserWidget');
            this._settings.set_strv(SETTINGS_KEY_ORDER, savedOrder);
        }
        const hiddenIds = this._settings.get_strv(SETTINGS_KEY_HIDDEN)
            .filter(id => id !== 'UserWidget');
        const disabledIds = this._settings.get_strv(SETTINGS_KEY_DISABLED)
            .filter(id => id !== 'UserWidget');
        this._settings.set_strv(SETTINGS_KEY_HIDDEN, hiddenIds);
        this._settings.set_strv(SETTINGS_KEY_DISABLED, disabledIds);

        // Remember the original (stock, before any manipulation) child
        // order so available-elements can be published from it — this is
        // what makes Reset restore the original layout instead of re-saving
        // whatever order the user last applied.
        const stockItems = this._grid.get_children();
        this._stockIdOf = stockItems.length > 0
            ? this._computeIds(stockItems)
            : {idOf: new Map(), kindOf: new Map()};

        // Expand/collapse button: styled like the background apps row
        // (flat quick toggle with a chevron on the right) and positioned
        // in the grid right after the last tile, so it sits just below
        // the quick tiles and above the background apps row
        this._expandBtn = new St.Button({
            style_class: 'quick-toggle button background-apps-quick-toggle',
            x_expand: true,
            can_focus: true,
            accessible_name: _('Show hidden quick settings'),
        });
        const expandBox = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._expandLabel = new St.Label({
            style_class: 'quick-toggle-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            text: _('Show more'),
        });
        expandBox.add_child(this._expandLabel);
        this._expandIcon = new St.Icon({
            style_class: 'quick-toggle-icon',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
            icon_name: 'pan-down-symbolic',
        });
        expandBox.add_child(this._expandIcon);
        this._expandBtn.set_child(expandBox);
        this._addHandler(this._expandBtn, this._expandBtn.connect('clicked', () => {
            const contentHeight = this._menu?.box?.get_height();
            this._expanded = !this._expanded;
            this._applySettings();
            this._animateQuickSettingsResize(contentHeight);
        }));
        this._grid.add_child(this._expandBtn);
        // Full-width row in the grid layout (values above the column
        // count are clamped by QuickSettingsLayout)
        this._grid.layout_manager.child_set_property(
            this._grid, this._expandBtn, 'column-span', 999);

        // Re-apply when the menu opens (items may have changed)
        this._addHandler(this._menu, this._menu.connect('open-state-changed',
            (_menu, open) => {
                if (open)
                    this._applySettings();
            }));

        // Re-apply when items are added or removed (e.g. by another
        // extension, or a background app closing)
        this._addHandler(this._grid, this._grid.connect('child-added',
            () => this._applySettings()));
        this._addHandler(this._grid, this._grid.connect('child-removed',
            () => this._applySettings()));

        // Watch for changes in settings
        this._addHandler(this._settings,
            this._settings.connect('changed::' + SETTINGS_KEY_ORDER,
                () => this._applySettings()));
        this._addHandler(this._settings,
            this._settings.connect('changed::' + SETTINGS_KEY_HIDDEN,
                () => this._applySettings()));
        this._addHandler(this._settings,
            this._settings.connect('changed::' + SETTINGS_KEY_DISABLED,
                () => this._applySettings()));
        this._addHandler(this._settings,
            this._settings.connect('changed::' + SETTINGS_KEY_USER_WIDGET_ENABLED,
                () => this._applySettings()));
        this._addHandler(this._settings,
            this._settings.connect('changed::' + SETTINGS_KEY_SYSTEM_ITEMS_ORDER,
                () => this._applySystemRowSettings()));
        this._addHandler(this._settings,
            this._settings.connect('changed::' + SETTINGS_KEY_HIDDEN_SYSTEM_ITEMS,
                () => this._applySystemRowSettings()));
        for (const key of [
            SETTINGS_KEY_BATTERY_SHOW_PERCENTAGE,
            SETTINGS_KEY_BATTERY_SHOW_LOGO,
            SETTINGS_KEY_BATTERY_HIDE_ABOVE_ENABLED,
            SETTINGS_KEY_BATTERY_HIDE_ABOVE_THRESHOLD,
            SETTINGS_KEY_BATTERY_HIDE_PLUGGED_ENABLED,
            SETTINGS_KEY_BATTERY_HIDE_PLUGGED_THRESHOLD,
        ]) {
            this._addHandler(this._settings, this._settings.connect(
                'changed::' + key, () => this._applySystemRowSettings()));
        }

        // Live-update the user widget sizes
        this._addHandler(this._settings,
            this._settings.connect('changed::' + SETTINGS_KEY_AVATAR_SIZE,
                () => this._applyUserWidgetStyle()));
        this._addHandler(this._settings,
            this._settings.connect('changed::' + SETTINGS_KEY_TEXT_SIZE,
                () => this._applyUserWidgetStyle()));

        this._fixSystemMenuPosition();
        this._initSystemRowItems();

        // Apply sizing after the user widget is created in _initQuickSettings
        if (this._userWidget)
            this._applyUserWidgetStyle();

        this._applySettings();
    }

    _addHandler(obj, id) {
        this._handlers.push({obj, id});
    }

    /** Animate the open Quick Settings popup to its new natural height. */
    _animateQuickSettingsResize(startHeight) {
        const menu = this._menu;
        // Animate the content box, not the outer BoxPointer actor: GNOME's
        // popup container owns the latter's allocation and can override its
        // explicit height. The content box's changing request propagates to
        // the popup naturally on each animation frame.
        const content = menu?.box;
        if (!content || !menu.isOpen || !Number.isFinite(startHeight) ||
            startHeight <= 0)
            return;

        // Hold the current panel height while the changed tile visibility is
        // laid out. Measuring immediately in the button handler can return
        // the old preferred height before QuickSettingsLayout has run.
        this._grid?.layout_manager.layout_changed();
        this._grid?.queue_relayout();
        content.remove_transition('height');
        content.set_height(startHeight);

        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (this._menu !== menu || !menu.isOpen || !this._grid) {
                content.set_height(-1);
                return GLib.SOURCE_REMOVE;
            }

            content.set_height(-1);
            const [, targetHeight] = content.get_preferred_height(-1);
            if (!Number.isFinite(targetHeight) || targetHeight <= 0 ||
                Math.abs(targetHeight - startHeight) < 1) {
                content.set_height(-1);
                return GLib.SOURCE_REMOVE;
            }

            content.set_height(startHeight);
            content.ease({
                height: targetHeight,
                duration: 240,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => content.set_height(-1),
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * GNOME's QuickToggleMenu binds its overlay actor's Y to its source
     * button's local Y. SystemItem's shutdown button is nested inside the
     * row, so that local coordinate does not follow the row when reordered.
     * Bind the overlay to the grid-level SystemItem row instead.
     */
    _fixSystemMenuPosition() {
        const systemItem = this._getItems()
            .find(item => item.constructor?.name === 'SystemItem');
        const menu = systemItem?.menu;
        if (!menu || this._systemMenu === menu)
            return;

        const verticalConstraint = menu.actor.get_constraints()
            .find(constraint => constraint instanceof Clutter.BindConstraint &&
                constraint.coordinate === Clutter.BindCoordinate.Y);
        if (!verticalConstraint)
            return;

        this._systemMenu = menu;
        this._systemMenuOriginalConstraint = verticalConstraint;
        menu.actor.remove_constraint(verticalConstraint);

        const rowConstraint = new Clutter.BindConstraint({
            name: 'qsm-system-row-y',
            coordinate: Clutter.BindCoordinate.Y,
            source: systemItem,
            offset: systemItem.height,
        });
        menu.actor.add_constraint(rowConstraint);
        this._systemMenuHeightBinding = systemItem.bind_property(
            'height', rowConstraint, 'offset', GObject.BindingFlags.SYNC_CREATE);
    }

    _initSystemRowItems() {
        this._systemRow = this._getItems()
            .find(item => item.constructor?.name === 'SystemItem');
        this._systemRowContainer = this._systemRow?.child ?? null;
        if (!this._systemRowContainer)
            return;
        this._systemRowOriginalChildren =
            this._systemRowContainer.get_children();
        const nativeSpacers = [
            this._systemRow._laptopSpacer,
            this._systemRow._desktopSpacer,
        ].filter(Boolean);
        for (const spacer of nativeSpacers)
            this._systemRowContainer.remove_child(spacer);

        for (const id of SYSTEM_ROW_IDS) {
            const item = id === 'AirplaneModeItem'
                ? this._createAirplaneModeItem()
                : this._systemRowContainer.get_children()
                    .find(child => child.constructor?.name === id);
            if (!item)
                continue;

            this._systemRowItems.set(id, item);
            this._systemRowNativeVisibility.set(id, item.visible);
            this._addHandler(item, item.connect('notify::visible', () => {
                if (this._applyingSystemRowSettings)
                    return;
                // Retain GNOME's dynamic availability (battery, session mode,
                // permissions) separately from the user's hide preference.
                this._systemRowNativeVisibility.set(id, item.visible);
                this._applySystemRowSettings();
            }));
        }

        const powerToggle = this._systemRowItems.get('PowerToggle');
        if (powerToggle) {
            this._batteryOriginalState = {
                iconVisible: powerToggle._icon?.visible,
                titleVisible: powerToggle._title?.visible,
                boxStyle: powerToggle._box?.style ?? null,
                boxExpand: powerToggle._box?.x_expand,
                titleExpand: powerToggle._title?.get_parent()?.x_expand,
                actorStyle: powerToggle.style ?? null,
                actorWidth: powerToggle.width,
                actorExpand: powerToggle.x_expand,
            };
            this._addHandler(powerToggle, powerToggle.connect('notify::title',
                () => this._applySystemRowSettings()));
            if (powerToggle._proxy) {
                this._addHandler(powerToggle._proxy,
                    powerToggle._proxy.connect('g-properties-changed',
                        () => this._applySystemRowSettings()));
            }
        }

        if (this._rfkillManager) {
            this._addHandler(this._rfkillManager,
                this._rfkillManager.connect('notify::show-airplane-mode',
                    () => this._syncAirplaneMode()));
            this._addHandler(this._rfkillManager,
                this._rfkillManager.connect('notify::airplane-mode',
                    () => this._syncAirplaneMode()));
            this._syncAirplaneMode();
        }

        this._applySystemRowSettings();
    }

    _createAirplaneModeItem() {
        if (this._airplaneModeItem)
            return this._airplaneModeItem;
        const item = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            checked: false,
            accessible_name: _('Airplane Mode'),
            child: new St.Icon({icon_name: 'airplane-mode-symbolic'}),
        });
        item._qsmId = 'AirplaneModeItem';
        this._rfkillManager = Rfkill.getRfkillManager();
        item.connect('clicked', () => {
            if (this._rfkillManager) {
                this._rfkillManager.airplane_mode =
                    !this._rfkillManager.airplane_mode;
            }
        });
        this._systemRowContainer.add_child(item);
        this._airplaneModeItem = item;
        return item;
    }

    _syncAirplaneMode() {
        if (!this._rfkillManager || !this._airplaneModeItem || !this._settings)
            return;
        const available = this._rfkillManager.show_airplane_mode;
        this._systemRowNativeVisibility.set('AirplaneModeItem', available);
        const active = this._rfkillManager.airplane_mode;
        this._airplaneModeItem.checked = active;
        const icon = this._airplaneModeItem.get_child();
        this._airplaneModeItem.style = active
            ? 'background-color: -st-accent-color; color: -st-accent-fg-color;'
            : null;
        if (icon)
            icon.style = active ? 'color: -st-accent-fg-color;' : null;
        this._applySystemRowSettings();
    }

    _applySystemRowSettings() {
        if (!this._systemRowContainer || this._systemRowItems.size === 0 ||
            this._applyingSystemRowSettings)
            return;

        this._applyingSystemRowSettings = true;
        try {
            const savedOrder = this._settings.get_strv(
                SETTINGS_KEY_SYSTEM_ITEMS_ORDER);
            const order = [];
            for (let id of savedOrder) {
                if (id === 'FlexibleSpacer')
                    id = 'FlexibleSpacer#1';
                if ((this._systemRowItems.has(id) || isSystemSpacerId(id)) &&
                    !order.includes(id))
                    order.push(id);
            }
            for (const id of SYSTEM_ROW_IDS) {
                if (this._systemRowItems.has(id) && !order.includes(id))
                    order.push(id);
            }
            if (order.length !== savedOrder.length ||
                order.some((id, i) => id !== savedOrder[i]))
                this._settings.set_strv(SETTINGS_KEY_SYSTEM_ITEMS_ORDER, order);

            const spacerIds = new Set(order.filter(isSystemSpacerId));
            for (const id of spacerIds) {
                if (!this._systemRowSpacers.has(id))
                    this._systemRowSpacers.set(id,
                        new Clutter.Actor({x_expand: true}));
            }
            for (const [id, spacer] of this._systemRowSpacers) {
                if (!spacerIds.has(id)) {
                    if (spacer.get_parent() === this._systemRowContainer)
                        this._systemRowContainer.remove_child(spacer);
                    spacer.destroy();
                    this._systemRowSpacers.delete(id);
                } else if (spacer.get_parent() !== this._systemRowContainer) {
                    this._systemRowContainer.add_child(spacer);
                }
            }

            const hidden = new Set(this._settings.get_strv(
                SETTINGS_KEY_HIDDEN_SYSTEM_ITEMS));
            for (const id of SYSTEM_ROW_IDS) {
                const item = this._systemRowItems.get(id);
                const available = this._systemRowNativeVisibility.get(id);
                let show = Boolean(available) && !hidden.has(id);
                if (id === 'PowerToggle' && show) {
                    show = this._settings.get_boolean(
                        SETTINGS_KEY_BATTERY_SHOW_LOGO) ||
                        this._batteryPercentageShouldShow();
                }
                item.visible = show;
            }

            // Place configurable flexible spacers among the system-row actions.
            const children = this._systemRowContainer.get_children();
            const arranged = [];
            for (const id of order) {
                if (isSystemSpacerId(id)) {
                    arranged.push(this._systemRowSpacers.get(id));
                    continue;
                }
                const item = this._systemRowItems.get(id);
                if (item)
                    arranged.push(item);
            }
            const known = new Set(arranged);
            for (const child of children) {
                if (!known.has(child))
                    arranged.push(child);
            }
            arranged.forEach((child, index) => {
                if (this._systemRowContainer.get_child_at_index(index) !== child)
                    this._systemRowContainer.set_child_at_index(child, index);
            });
            this._applyBatteryIndicatorAppearance();
        } finally {
            this._applyingSystemRowSettings = false;
        }
    }

    _batteryPercentageShouldShow() {
        if (!this._settings.get_boolean(SETTINGS_KEY_BATTERY_SHOW_PERCENTAGE))
            return false;

        const powerToggle = this._systemRowItems.get('PowerToggle');
        const proxy = powerToggle?._proxy;
        const percentage = Number(proxy?.Percentage);
        if (!Number.isFinite(percentage))
            return true;

        const hiddenAbove = this._settings.get_boolean(
            SETTINGS_KEY_BATTERY_HIDE_ABOVE_ENABLED) &&
            percentage >= this._settings.get_int(
                SETTINGS_KEY_BATTERY_HIDE_ABOVE_THRESHOLD);
        const state = proxy?.State;
        const pluggedIn = state === UPower.DeviceState.CHARGING ||
            state === UPower.DeviceState.FULLY_CHARGED ||
            state === UPower.DeviceState.PENDING_CHARGE;
        const hiddenWhilePlugged = this._settings.get_boolean(
            SETTINGS_KEY_BATTERY_HIDE_PLUGGED_ENABLED) && pluggedIn &&
            percentage >= this._settings.get_int(
                SETTINGS_KEY_BATTERY_HIDE_PLUGGED_THRESHOLD);
        return !hiddenAbove && !hiddenWhilePlugged;
    }

    _applyBatteryIndicatorAppearance() {
        const powerToggle = this._systemRowItems.get('PowerToggle');
        if (!powerToggle || !this._settings)
            return;

        const showPercentage = this._batteryPercentageShouldShow();
        if (powerToggle._title) {
            powerToggle._title.visible = showPercentage;
            // The title is inside an x-expanding box. Hide that whole box as
            // well, otherwise it can retain the battery pill's old width.
            const titleBox = powerToggle._title.get_parent();
            if (titleBox)
                titleBox.visible = showPercentage;
        }
        const showLogo = this._settings.get_boolean(
            SETTINGS_KEY_BATTERY_SHOW_LOGO);
        if (powerToggle._icon)
            powerToggle._icon.visible = showLogo;

        // The stock QuickToggle has tile-sized padding. In the compact system
        // row, clear it when one child remains so the pill follows that child.
        if (powerToggle._box) {
            const visibleChildren = Number(showLogo) + Number(showPercentage);
            powerToggle._box.x_expand = false;
            powerToggle._box.style = visibleChildren === 1
                ? 'padding: 8px 12px; spacing: 0;'
                : null;
            if (powerToggle._title?.get_parent())
                powerToggle._title.get_parent().x_expand = false;
            powerToggle.x_expand = false;
            powerToggle.style = 'min-width: 40px; min-height: 40px;';
            const [, iconWidth] = showLogo
                ? powerToggle._icon.get_preferred_width(-1) : [0, 0];
            const [, titleWidth] = showPercentage
                ? powerToggle._title.get_preferred_width(-1) : [0, 0];
            const innerSpacing = showLogo && showPercentage ? 9 : 0;
            const horizontalPadding = visibleChildren === 1 ? 24 : 40;
            const contentWidth = Math.ceil(
                iconWidth + titleWidth + innerSpacing + horizontalPadding);
            powerToggle.set_width(Math.max(40, contentWidth));
            powerToggle._box.queue_relayout();
        }

        powerToggle.queue_relayout();
        this._systemRowContainer?.queue_relayout();
        this._grid?.queue_relayout();
    }

    /**
     * Create the user widget (avatar + user name, the widget the login
     * screen uses) and put it at the top of the grid. It is owned by
     * this extension and destroyed again on disable().
     */
    _createUserWidget() {
        if (this._userWidget || !this._grid)
            return;
        try {
            const userManager = AccountsService.UserManager.get_default();
            const user = userManager.get_user(GLib.get_user_name());
            if (!user) {
                // AccountsService can finish loading after the quick-settings
                // menu is ready. Retry rather than silently losing the item.
                if (!this._userWidgetRetryId) {
                    this._userWidgetRetryId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, 1, () => {
                            this._userWidgetRetryId = null;
                            this._createUserWidget();
                            return GLib.SOURCE_REMOVE;
                        });
                }
                return;
            }
            this._userWidget = new UserWidget.UserWidget(user);
            this._userWidget._qsmId = 'UserWidget';
            this._grid.insert_child_at_index(this._userWidget, 0);
            // Full-width row (values above the column count are clamped
            // by QuickSettingsLayout)
            this._grid.layout_manager.child_set_property(
                this._grid, this._userWidget, 'column-span', 999);
            this._addHandler(user, user.connect('changed',
                () => this._applyUserWidgetStyle()));
            this._addHandler(user, user.connect('notify::is-loaded',
                () => this._applyUserWidgetStyle()));
            this._applyUserWidgetStyle();
        } catch (e) {
            logError(e, 'Quick Settings Manager: failed to add the user widget');
            this._userWidget = null;
        }
    }

    /**
     * Apply the configurable sizes to the user widget. Rebuild the Avatar
     * with the selected iconSize so its natural allocation changes too;
     * apply text size directly to labels.
     */
    _applyUserWidgetStyle() {
        const widget = this._userWidget;
        if (!widget)
            return;
        try {
            const avatarSize = this._settings.get_int(SETTINGS_KEY_AVATAR_SIZE);
            let avatar = widget._avatar ?? widget.get_children()
                .find(c => c.constructor?.name === 'Avatar');
            if (avatar && avatar._qsmAvatarSize !== avatarSize) {
                // Follow the avatar-quick-settings extension's working
                // method: construct Avatar with iconSize, then set CSS
                // icon-size so GNOME's natural-size/layout calculation uses it.
                const replacement = new UserWidget.Avatar(widget._user, {
                    iconSize: avatarSize,
                    // Avoid GNOME's `.user-icon` theme rule, which fixes the
                    // avatar to the stock 64px size.
                    styleClass: 'qsm-user-avatar',
                });
                replacement.update();
                replacement.style = `icon-size: ${avatarSize}px;`;
                replacement._qsmAvatarSize = avatarSize;

                const index = widget.get_children().indexOf(avatar);
                widget.remove_child(avatar);
                widget.insert_child_at_index(replacement,
                    Math.max(0, index));
                widget._avatar = replacement;
                avatar = replacement;
                widget.queue_relayout();
                this._grid?.queue_relayout();
            }

            const textSize = this._settings.get_int(SETTINGS_KEY_TEXT_SIZE);
            const labels = [];
            this._collectUserWidgetLabels(widget, labels);
            for (const label of labels) {
                const style = `font-size: ${textSize}px;`;
                if (label.style !== style)
                    label.style = style;
            }

        } catch (e) {
            logError(e, 'Quick Settings Manager: failed to style the user widget');
        }
    }

    _collectUserWidgetLabels(actor, out) {
        if (actor instanceof St.Label &&
            actor.has_style_class_name('user-widget-label'))
            out.push(actor);
        for (const child of actor.get_children())
            this._collectUserWidgetLabels(child, out);
    }

    _getItems() {
        const items = [];
        if (!this._grid)
            return items;
        for (const child of this._grid.get_children()) {
            if (child instanceof QuickSettingsItem || child === this._userWidget)
                items.push(child);
        }
        return items;
    }

    _kindOfItem(item) {
        if (item instanceof QuickSlider)
            return KIND_SLIDER;
        // SystemItem, BackgroundAppsToggle, and UserWidget are not tiles.
        // The expand button is positioned above the background apps row.
        const name = item.constructor.name;
        if (name === 'SystemItem' || name === 'BackgroundAppsToggle' ||
            name === 'UserWidget')
            return KIND_OTHER;
        return KIND_TILE;
    }

    /**
     * Compute a stable id for every item: constructor name, with the title
     * (and a numeric suffix) appended when several items share a name.
     * Also classifies each item as tile / slider / other.
     */
    _computeIds(items) {
        const used = new Set();
        const idOf = new Map();
        const kindOf = new Map();
        for (const item of items) {
            let id = item._qsmId || item.constructor.name;
            if (used.has(id)) {
                const title = typeof item.title === 'string' ? item.title : '';
                let alt = title ? `${id}|${title}` : id;
                if (used.has(alt)) {
                    let n = 2;
                    while (used.has(`${alt}#${n}`))
                        n++;
                    alt = `${alt}#${n}`;
                }
                id = alt;
            }
            used.add(id);
            idOf.set(item, id);
            kindOf.set(item, this._kindOfItem(item));
        }
        return {idOf, kindOf};
    }

    /**
     * Write a string-to-string dict to a settings key, but only when its
     * contents actually changed (deep_unpack is required: unpack() on
     * a{ss} leaves the string values as empty objects).
     */
    _setStringDict(key, dict) {
        const old = this._settings.get_value(key).deep_unpack();
        const oldKeys = Object.keys(old);
        const newKeys = Object.keys(dict);
        let changed = oldKeys.length !== newKeys.length;
        if (!changed) {
            for (const k of newKeys) {
                if (!(k in old) || old[k] !== dict[k]) {
                    changed = true;
                    break;
                }
            }
        }
        if (changed) {
            this._settings.set_value(key, new GLib.Variant('a{ss}', dict));
        }
    }

    /**
     * Publish original items first (for Reset), followed by currently live
     * items added by other extensions after our initial snapshot.
     */
    _publishAvailable(idOf, stockIdOf) {
        const available = {};
        const published = new Set();
        const add = (item, id) => {
            try {
                let title = typeof item.title === 'string'
                    ? item.title : '';
                if (!title && item.constructor?.name === 'UserWidget')
                    title = _('User Avatar');
                available[id] = title;
                published.add(item);
            } catch (e) {
                // Item was destroyed — skip it
            }
        };
        for (const [item] of stockIdOf?.idOf ?? []) {
            const liveId = idOf.get(item);
            if (liveId !== undefined)
                add(item, liveId);
        }
        for (const [item, id] of idOf) {
            if (!published.has(item))
                add(item, id);
        }
        // Keep the row available/reorderable even if actor construction fails.
        available.UserWidget = _('User Avatar');
        this._setStringDict(SETTINGS_KEY_AVAILABLE, available);
    }

    _publishTypes(idOf, kindOf) {
        const types = {};
        for (const [item, id] of idOf) {
            types[id] = kindOf.get(item);
        }
        types.UserWidget = KIND_OTHER;
        this._setStringDict(SETTINGS_KEY_TYPES, types);
    }

    /**
     * Move items into the saved order. Items not in the saved order keep
     * their relative position after all ordered items.
     */
    _applyOrder(idOf, order) {
        const byId = new Map();
        for (const [item, id] of idOf)
            byId.set(id, item);

        let last = null;
        for (const id of order) {
            const item = byId.get(id);
            if (!item)
                continue;
            if (!last) {
                const first = this._grid.get_first_child();
                if (first && first !== item)
                    this._grid.set_child_above_sibling(item, first);
            } else {
                this._grid.set_child_above_sibling(item, last);
            }
            last = item;
        }
    }

    /**
     * Apply the three-state visibility model:
     *   - disabled tiles are never shown
     *   - hidden tiles follow the expand/collapse state
     *   - sliders/others with the id in hidden-elements are fully hidden
     * Only items we hid ourselves are ever shown again, so elements GNOME
     * hides on its own (e.g. unsupported night light) stay hidden.
     */
    _applyVisibility(idOf, kindOf, hidden, disabled) {
        for (const [item, id] of idOf) {
            const kind = kindOf.get(item);
            let show = true;
            // UserWidget has its own visibility setting; disabled applies
            // to regular quick-settings elements.
            if (id === 'UserWidget') {
                show = this._settings.get_boolean(
                    SETTINGS_KEY_USER_WIDGET_ENABLED);
            } else if (disabled.has(id)) {
                show = false;
            } else if (kind === KIND_TILE && hidden.has(id)) {
                show = this._expanded;
            } else if (kind !== KIND_TILE && hidden.has(id)) {
                show = false;
            }

            if (!show) {
                if (item.visible) {
                    item.visible = false;
                    this._hiddenByUs.add(item);
                }
            } else if (this._hiddenByUs.has(item)) {
                this._hiddenByUs.delete(item);
                item.visible = true;
            }
        }
    }

    _watchDisabledVisibility(idOf) {
        for (const [item, id] of idOf) {
            if (this._visibilityWatched.has(item))
                continue;
            this._visibilityWatched.add(item);
            this._addHandler(item, item.connect('notify::visible', () => {
                if (this._applying || !this._settings || !item.visible)
                    return;
                if (!this._settings.get_strv(SETTINGS_KEY_DISABLED).includes(id))
                    return;

                // GNOME or another extension may make a tile visible again
                // after our settings were applied. Re-enforce the user's
                // disabled choice while leaving non-disabled items alone.
                this._hiddenByUs.add(item);
                item.visible = false;
            }));
        }
    }

    /**
     * Keep the expand button immediately after the last tile so it always
     * sits just below the quick tiles (idOf follows grid order). The
     * background apps row is not a tile, so the button always stays above
     * it, even when the row was reordered up into the tiles.
     */
    _positionExpandButton(idOf, kindOf) {
        const btn = this._expandBtn;
        if (!btn)
            return;
        let lastTile = null;
        let bgApps = null;
        for (const [item] of idOf) {
            if (kindOf.get(item) === KIND_TILE)
                lastTile = item;
            if (item.constructor.name === 'BackgroundAppsToggle')
                bgApps = item;
        }

        const children = this._grid.get_children();
        const tileIdx = lastTile ? children.indexOf(lastTile) : -1;
        const bgIdx = bgApps ? children.indexOf(bgApps) : -1;
        if (bgApps && (tileIdx < 0 || bgIdx < tileIdx)) {
            // Place the button right before the background apps row
            if (children[bgIdx - 1] !== btn)
                this._grid.set_child_below_sibling(btn, bgApps);
        } else if (lastTile && lastTile.get_next_sibling() !== btn) {
            this._grid.set_child_above_sibling(btn, lastTile);
        }
    }

    /**
     * Show the button only when there is something to reveal, flip its
     * label/chevron with the expanded state.
     */
    _updateExpandButton(idOf, kindOf, hidden, disabled) {
        const btn = this._expandBtn;
        if (!btn)
            return;
        let revealable = 0;
        for (const [item, id] of idOf) {
            if (kindOf.get(item) === KIND_TILE &&
                hidden.has(id) && !disabled.has(id))
                revealable++;
        }
        if (revealable === 0)
            this._expanded = false;
        btn.visible = revealable > 0;
        if (this._expandLabel)
            this._expandLabel.text = this._expanded
                ? _('Show less') : _('Show more');
        if (this._expandIcon)
            this._expandIcon.icon_name = this._expanded
                ? 'pan-up-symbolic' : 'pan-down-symbolic';
    }

    _applySettings() {
        if (!this._grid || this._applying)
            return;
        this._applying = true;
        try {
            const items = this._getItems();
            const {idOf, kindOf} = this._computeIds(items);
            this._watchDisabledVisibility(idOf);

            this._publishAvailable(idOf, this._stockIdOf);
            this._publishTypes(idOf, kindOf);

            const order = this._settings.get_strv(SETTINGS_KEY_ORDER);
            const orderedIds = new Set(order);
            let orderChanged = false;
            for (const [, id] of idOf) {
                if (orderedIds.has(id))
                    continue;
                // Preserve saved positions, adding newly discovered items
                // just before Background Apps (or at the end if it is absent).
                let insertAt = order.indexOf('BackgroundAppsToggle');
                if (insertAt < 0)
                    insertAt = order.length;
                order.splice(insertAt, 0, id);
                orderedIds.add(id);
                orderChanged = true;
            }
            if (orderChanged)
                this._settings.set_strv(SETTINGS_KEY_ORDER, order);
            const hidden = new Set(this._settings.get_strv(SETTINGS_KEY_HIDDEN));
            const disabled = new Set(this._settings.get_strv(SETTINGS_KEY_DISABLED));

            this._applyOrder(idOf, order);
            this._applyVisibility(idOf, kindOf, hidden, disabled);
            this._positionExpandButton(idOf, kindOf);
            this._updateExpandButton(idOf, kindOf, hidden, disabled);
        } finally {
            this._applying = false;
        }
    }

    disable() {
        // Remove pending timeout
        if (this._destroyId) {
            GLib.Source.remove(this._destroyId);
            this._destroyId = null;
        }
        if (this._userWidgetRetryId) {
            GLib.Source.remove(this._userWidgetRetryId);
            this._userWidgetRetryId = null;
        }

        // Disconnect all signal handlers from the objects they belong to
        for (const handler of this._handlers) {
            try {
                handler.obj?.disconnect(handler.id);
            } catch (e) {
                // Ignore errors during cleanup
            }
        }
        this._handlers = [];

        // Restore GNOME's native row visibility and child order.
        if (this._systemRowContainer) {
            const powerToggle = this._systemRowItems.get('PowerToggle');
            if (powerToggle && this._batteryOriginalState) {
                const original = this._batteryOriginalState;
                if (powerToggle._icon && original.iconVisible !== undefined)
                    powerToggle._icon.visible = original.iconVisible;
                if (powerToggle._title && original.titleVisible !== undefined)
                    powerToggle._title.visible = original.titleVisible;
                if (powerToggle._box) {
                    powerToggle._box.style = original.boxStyle;
                    powerToggle._box.x_expand = original.boxExpand;
                }
                if (powerToggle._title?.get_parent() &&
                    original.titleExpand !== undefined)
                    powerToggle._title.get_parent().x_expand =
                        original.titleExpand;
                powerToggle.style = original.actorStyle;
                powerToggle.width = original.actorWidth;
                powerToggle.x_expand = original.actorExpand;
            }
            for (const [id, item] of this._systemRowItems) {
                const nativeVisible = this._systemRowNativeVisibility.get(id);
                if (nativeVisible !== undefined)
                    item.visible = nativeVisible;
            }
            for (const spacer of this._systemRowSpacers.values()) {
                if (spacer.get_parent() === this._systemRowContainer)
                    this._systemRowContainer.remove_child(spacer);
                spacer.destroy();
            }
            if (this._airplaneModeItem) {
                if (this._airplaneModeItem.get_parent() === this._systemRowContainer)
                    this._systemRowContainer.remove_child(this._airplaneModeItem);
                this._airplaneModeItem.destroy();
            }
            for (const [index, child] of
                (this._systemRowOriginalChildren ?? []).entries()) {
                if (child.get_parent() !== this._systemRowContainer)
                    this._systemRowContainer.add_child(child);
                this._systemRowContainer.set_child_at_index(child, index);
            }
        }
        this._rfkillManager = null;
        this._systemRow = null;
        this._systemRowContainer = null;
        this._systemRowOriginalChildren = null;
        this._systemRowItems.clear();
        this._systemRowSpacers.clear();
        this._systemRowNativeVisibility.clear();
        this._airplaneModeItem = null;
        this._batteryOriginalState = null;

        // Remove the expand button (handlers are already disconnected, so
        // its removal cannot re-trigger _applySettings)
        if (this._expandBtn) {
            try {
                this._expandLabel?.destroy();
                this._expandIcon?.destroy();
                this._expandBtn.destroy();
            } catch (e) {
                // Already destroyed
            }
            this._expandBtn = null;
            this._expandLabel = null;
            this._expandIcon = null;
        }

        // Restore the original item order (items destroyed since enable()
        // are skipped — their wrappers may be finalized)
        if (this._grid && this._originalOrder) {
            let last = null;
            for (const item of this._originalOrder) {
                try {
                    if (item.get_parent() !== this._grid)
                        continue;
                    if (!last) {
                        const first = this._grid.get_first_child();
                        if (first && first !== item)
                            this._grid.set_child_above_sibling(item, first);
                    } else {
                        this._grid.set_child_above_sibling(item, last);
                    }
                    last = item;
                } catch (e) {
                    // Item was destroyed; leave it out of the restore
                }
            }
        }

        // Restore visibility only for items we hid ourselves, so items
        // GNOME hides on its own (e.g. airplane mode) stay hidden
        for (const item of this._hiddenByUs) {
            try {
                item.visible = true;
            } catch (e) {
                // Item was destroyed
            }
        }
        this._hiddenByUs.clear();
        this._visibilityWatched.clear();

        if (this._systemMenuHeightBinding) {
            this._systemMenuHeightBinding.unbind();
            this._systemMenuHeightBinding = null;
        }
        if (this._systemMenu?.actor && this._systemMenuOriginalConstraint) {
            this._systemMenu.actor.remove_constraint_by_name(
                'qsm-system-row-y');
            this._systemMenu.actor.add_constraint(
                this._systemMenuOriginalConstraint);
        }
        this._systemMenu = null;
        this._systemMenuOriginalConstraint = null;

        // The user widget is owned by this extension
        if (this._userWidget) {
            try {
                this._userWidget.destroy();
            } catch (e) {
                // Already destroyed
            }
            this._userWidget = null;
        }

        this._expanded = false;
        this._originalOrder = null;
        this._settings = null;
        this._menu = null;
        this._grid = null;
        if (this._avatarStylesheet) {
            try {
                St.ThemeContext.get_for_stage(global.stage).get_theme()
                    .unload_stylesheet(this._avatarStylesheet);
            } catch (e) {
                logError(e, 'Quick Settings Manager: failed to unload user widget style');
            }
            this._avatarStylesheet = null;
        }
    }
}

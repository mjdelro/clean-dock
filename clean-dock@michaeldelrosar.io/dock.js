import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as AppMenu from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {IntellihideMonitor} from './intellihide.js';

const MIN_ICON_SIZE = 24;
const TRIGGER_HEIGHT = 6;
const TRIGGER_SIDE_PAD = 24;
const ANIM_MS = 180;
const SCROLL_COOLDOWN_US = 120_000;

export class MonitorDock {
    constructor(monitorIndex, notificationsMonitor, settings) {
        this._monitorIndex = monitorIndex;
        this._monitor = Main.layoutManager.monitors[monitorIndex];
        this._notifications = notificationsMonitor;
        this._settings = settings;

        this._destroyed = false;
        this._initialized = false;
        this._hovered = false;
        this._menuOpen = false;
        this._hidden = false;
        this._styleKey = '';
        this._hideTimeoutId = 0;
        this._rebuildId = 0;
        this._stateUpdateId = 0;
        this._menuDestroyId = 0;
        this._activeMenu = null;
        this._activeMenuOpenId = 0;
        this._dockRect = null;
        this._iconSize = 0;
        this._itemOrderKey = '';
        this._items = new Map();
        this._separator = null;
        this._scrollAccum = 0;
        this._lastScrollUs = 0;

        // Bottom-edge reveal strip, sized to the dock pill and shown only while auto-hidden.
        this._trigger = new St.Widget({
            reactive: true,
            track_hover: true,
            visible: false,
            x: this._monitor.x,
            y: this._monitor.y + this._monitor.height - TRIGGER_HEIGHT,
            width: 160,
            height: TRIGGER_HEIGHT,
        });
        this._triggerHoverId = this._trigger.connect('notify::hover', () => this._syncHoverState());
        Main.layoutManager.addChrome(this._trigger, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._root = new St.Bin({
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });

        this._pill = new St.BoxLayout({
            style_class: 'clean-dock-pill transparent',
            reactive: true,
            track_hover: true,
            orientation: Clutter.Orientation.HORIZONTAL,
        });

        this._iconsBox = new St.BoxLayout({
            style_class: 'clean-dock-icons',
            orientation: Clutter.Orientation.HORIZONTAL,
        });

        this._pill.add_child(this._iconsBox);
        this._root.set_child(this._pill);

        Main.layoutManager.addChrome(this._root, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        // Persistent stage-attached tooltip avoids per-hover StLabel allocation and stage warnings.
        this._tooltip = new St.Label({
            style_class: 'clean-dock-tooltip',
            reactive: false,
            visible: false,
        });
        Main.layoutManager.addChrome(this._tooltip, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._menuManager = null;

        this._pillHoverId = this._pill.connect('notify::hover', () => this._syncHoverState());

        this._appSystem = Shell.AppSystem.get_default();
        this._windowTracker = Shell.WindowTracker.get_default();
        this._favorites = AppFavorites.getAppFavorites();

        this._signals = [
            [this._appSystem, this._appSystem.connect('installed-changed', () => this._scheduleRebuild())],
            [this._appSystem, this._appSystem.connect('app-state-changed', () => this._scheduleRebuild())],
            [this._windowTracker, this._windowTracker.connect('tracked-windows-changed', () => this._scheduleRebuild())],
            [this._windowTracker, this._windowTracker.connect('notify::focus-app', () => this._scheduleStateUpdate())],
            [this._favorites, this._favorites.connect('changed', () => this._scheduleRebuild())],
            [global.display, global.display.connect('window-created', (_d, win) => {
                if (!this._settings.get_boolean('isolate-monitors') || win.get_monitor() === this._monitorIndex)
                    this._scheduleRebuild();
            })],
            [global.display, global.display.connect('notify::focus-window', () => this._scheduleStateUpdate())],
            [global.display, global.display.connect('window-entered-monitor', (_d, monIdx) => {
                if (!this._settings.get_boolean('isolate-monitors') || monIdx === this._monitorIndex)
                    this._scheduleRebuild();
            })],
            [global.display, global.display.connect('window-left-monitor', (_d, monIdx) => {
                if (!this._settings.get_boolean('isolate-monitors') || monIdx === this._monitorIndex)
                    this._scheduleRebuild();
            })],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => {
                if (this._settings.get_boolean('isolate-workspaces'))
                    this._scheduleRebuild();
                else
                    this._scheduleStateUpdate();
            })],
            [Main.overview, Main.overview.connect('showing', () => this._updateVisibility())],
            [Main.overview, Main.overview.connect('hiding', () => this._updateVisibility())],
            [Main.overview, Main.overview.connect('hidden', () => this._updateVisibility())],
            [this._settings, this._settings.connect('changed::icon-size', () => this._scheduleRebuild())],
            [this._settings, this._settings.connect('changed::isolate-monitors', () => this._scheduleRebuild())],
            [this._settings, this._settings.connect('changed::isolate-workspaces', () => this._scheduleRebuild())],
            [this._settings, this._settings.connect('changed::bottom-margin', () => {
                this._positionRoot();
                this._intellihide?.recheck(false);
                this._updateVisibility();
            })],
            [this._settings, this._settings.connect('changed::intellihide', () => this._updateVisibility())],
            [this._settings, this._settings.connect('changed::dynamic-transparency', () => this._updateVisibility())],
            [this._settings, this._settings.connect('changed::transparent-opacity', () => this._updateVisibility())],
            [this._settings, this._settings.connect('changed::solid-opacity', () => this._updateVisibility())],
            [this._settings, this._settings.connect('changed::show-running-dots', () => this._scheduleStateUpdate())],
            [this._settings, this._settings.connect('changed::show-tooltips', () => {
                if (!this._settings.get_boolean('show-tooltips'))
                    this._hideTooltip();
            })],
        ];

        this._unsubNotif = this._notifications.onChanged(appId => this._onNotificationsChanged(appId));

        this._intellihide = new IntellihideMonitor(
            this._monitorIndex,
            () => this._getDockRect(),
            () => this._updateVisibility()
        );

        this._rebuildNow();
        this._initialized = true;
    }

    _getMonitorWindowsMRU(app) {
        const isolateMonitors = this._settings.get_boolean('isolate-monitors');
        const isolateWorkspaces = this._settings.get_boolean('isolate-workspaces');
        const activeWs = isolateWorkspaces
            ? global.workspace_manager.get_active_workspace()
            : null;

        return app.get_windows().filter(win => {
            if (win.is_skip_taskbar())
                return false;
            if (isolateMonitors && win.get_monitor() !== this._monitorIndex)
                return false;
            if (activeWs && !win.located_on_workspace(activeWs))
                return false;
            return true;
        });
    }

    // Sort by stable_sequence instead of MRU so cycling reaches 3+ windows instead of ping-ponging.
    _getMonitorWindowsStable(app) {
        return this._getMonitorWindowsMRU(app).sort(
            (a, b) => a.get_stable_sequence() - b.get_stable_sequence()
        );
    }

    _getDockRect() {
        if (this._destroyed || !this._pill?.get_stage() || !this._pill.visible)
            return null;
        return this._dockRect;
    }

    _positionRoot() {
        if (this._destroyed || !this._root?.get_stage() || !this._pill)
            return;

        const bottomMargin = this._settings.get_int('bottom-margin');
        const maxIconSize = this._settings.get_int('icon-size');
        const [, natW] = this._pill.get_preferred_width(-1);
        const [, natH] = this._pill.get_preferred_height(-1);

        const w = Math.min(natW, Math.floor(this._monitor.width * 0.94));
        const h = Math.max(1, natH);
        const x = this._monitor.x + Math.floor((this._monitor.width - w) / 2);
        const y = this._monitor.y + this._monitor.height - h - bottomMargin;
        this._root.set_position(x, y);
        this._root.set_size(w, h);

        const rectW = Math.max(w, 120);
        const rectH = Math.max(h, maxIconSize + 14) + bottomMargin;
        const rectX = this._monitor.x + Math.floor((this._monitor.width - rectW) / 2);
        this._dockRect = {
            x: rectX,
            y: this._monitor.y + this._monitor.height - rectH,
            width: rectW,
            height: rectH,
        };

        if (this._trigger) {
            const trigW = Math.min(this._monitor.width, rectW + TRIGGER_SIDE_PAD * 2);
            const trigX = Math.max(
                this._monitor.x,
                this._monitor.x + Math.floor((this._monitor.width - trigW) / 2)
            );
            this._trigger.set_position(trigX, this._monitor.y + this._monitor.height - TRIGGER_HEIGHT);
            this._trigger.set_size(trigW, TRIGGER_HEIGHT);
        }
    }

    _computeIconSize(itemCount) {
        const maxIconSize = this._settings.get_int('icon-size');
        if (itemCount <= 0)
            return maxIconSize;
        const maxWidth = Math.floor(this._monitor.width * 0.90) - 24;
        const perItem = Math.floor(maxWidth / itemCount) - 14;
        return Math.max(MIN_ICON_SIZE, Math.min(maxIconSize, perItem));
    }

    _scheduleRebuild() {
        if (this._destroyed || this._rebuildId)
            return;
        if (this._stateUpdateId) {
            GLib.Source.remove(this._stateUpdateId);
            this._stateUpdateId = 0;
        }
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this._rebuildNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleStateUpdate() {
        if (this._destroyed || this._rebuildId || this._stateUpdateId)
            return;
        this._stateUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._stateUpdateId = 0;
            this._updateItemStates();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuildNow() {
        if (this._destroyed || !this._iconsBox?.get_stage())
            return;

        const seenIds = new Set();
        const favApps = [];
        for (const app of this._favorites.getFavorites()) {
            const id = app?.get_id?.();
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                favApps.push(app);
            }
        }

        const runningNonFavs = [];
        for (const app of this._appSystem.get_running()) {
            const id = app?.get_id?.();
            if (id && !seenIds.has(id) && this._getMonitorWindowsMRU(app).length > 0) {
                seenIds.add(id);
                runningNonFavs.push(app);
            }
        }

        const totalItems = favApps.length + runningNonFavs.length;
        const iconSize = this._computeIconSize(totalItems);
        const orderKey = `${iconSize}|${favApps.map(a => a.get_id()).join(',')}|${runningNonFavs.map(a => a.get_id()).join(',')}`;

        if (orderKey === this._itemOrderKey) {
            this._updateItemStates();
            return;
        }

        this._itemOrderKey = orderKey;
        this._hideTooltip();

        // Full item rebuild is only needed when the computed icon pixel size changes.
        if (iconSize !== this._iconSize) {
            this._closeActiveMenu();
            this._iconsBox.destroy_all_children();
            this._items.clear();
            this._separator = null;
            this._iconSize = iconSize;
        } else {
            for (const [appId, item] of [...this._items.entries()]) {
                if (!seenIds.has(appId)) {
                    if (this._activeMenu?.sourceActor === item.btn)
                        this._closeActiveMenu();
                    this._items.delete(appId);
                    item.btn.destroy();
                }
            }
        }

        const focusWin = global.display.get_focus_window();
        const desiredChildren = [];

        for (const app of favApps) {
            const appId = app.get_id();
            let item = this._items.get(appId);
            if (!item) {
                item = this._createAppItem(app, iconSize, focusWin);
                this._items.set(appId, item);
                this._iconsBox.add_child(item.btn);
            }
            desiredChildren.push(item.btn);
        }

        const needSeparator = favApps.length > 0 && runningNonFavs.length > 0;
        if (needSeparator) {
            if (!this._separator) {
                this._separator = new St.Widget({
                    style_class: 'clean-dock-separator',
                    y_expand: true,
                });
                this._iconsBox.add_child(this._separator);
            }
            desiredChildren.push(this._separator);
        } else if (this._separator) {
            this._separator.destroy();
            this._separator = null;
        }

        for (const app of runningNonFavs) {
            const appId = app.get_id();
            let item = this._items.get(appId);
            if (!item) {
                item = this._createAppItem(app, iconSize, focusWin);
                this._items.set(appId, item);
                this._iconsBox.add_child(item.btn);
            }
            desiredChildren.push(item.btn);
        }

        for (let i = 0; i < desiredChildren.length; i++)
            this._iconsBox.set_child_at_index(desiredChildren[i], i);

        this._pill.visible = totalItems > 0;

        this._updateItemStates();
        this._positionRoot();
        this._intellihide?.recheck(false);
        this._updateVisibility();
    }

    _updateItemStates() {
        if (this._destroyed || !this._iconsBox?.get_stage())
            return;

        const focusWin = global.display.get_focus_window();
        const showDots = this._settings.get_boolean('show-running-dots');

        for (const [appId, item] of this._items) {
            const stableWindows = this._getMonitorWindowsStable(item.app);
            const focusIdx = focusWin ? stableWindows.indexOf(focusWin) : -1;
            const isFocused = focusIdx !== -1;
            const dotCount = showDots ? Math.min(stableWindows.length, 4) : 0;
            const focusedDot = isFocused && dotCount > 0 ? Math.min(focusIdx, dotCount - 1) : -1;
            const notifCount = this._notifications.getCount(appId);

            if (isFocused !== item.isFocused) {
                item.isFocused = isFocused;
                if (isFocused)
                    item.btn.add_style_class_name('focused');
                else
                    item.btn.remove_style_class_name('focused');
            }

            this._updateItemDots(item, dotCount, focusedDot);
            this._updateItemBadge(item, notifCount);
        }
    }

    _updateItemDots(item, dotCount, focusedDot) {
        if (dotCount === item.dotCount && focusedDot === item.focusedDot)
            return;

        const dotsBox = item.dotsBox;
        if (!dotsBox?.get_stage())
            return;

        while (dotsBox.get_n_children() > dotCount)
            dotsBox.get_last_child().destroy();

        while (dotsBox.get_n_children() < dotCount)
            dotsBox.add_child(new St.Widget({style_class: 'clean-dock-dot'}));

        const children = dotsBox.get_children();
        for (let i = 0; i < children.length; i++) {
            if (i === focusedDot)
                children[i].add_style_class_name('focused');
            else
                children[i].remove_style_class_name('focused');
        }

        item.dotCount = dotCount;
        item.focusedDot = focusedDot;
    }

    _onNotificationsChanged(appId) {
        if (this._destroyed || !this._iconsBox?.get_stage())
            return;

        if (appId) {
            const item = this._items.get(appId);
            if (item)
                this._updateItemBadge(item, this._notifications.getCount(appId));
            return;
        }

        for (const [id, item] of this._items)
            this._updateItemBadge(item, this._notifications.getCount(id));
    }

    _updateItemBadge(item, notifCount) {
        if (notifCount === item.notifCount || !item.badgeBin)
            return;

        item.notifCount = notifCount;
        if (notifCount <= 0) {
            item.badgeBin.hide();
            return;
        }

        const badgeText = notifCount > 999 ? '999+' : `${notifCount}`;
        item.badgeLabel.text = badgeText;
        if (badgeText.length > 1)
            item.badgeBin.add_style_class_name('wide');
        else
            item.badgeBin.remove_style_class_name('wide');
        item.badgeBin.show();
    }

    _createAppItem(app, iconSize, focusWin) {
        const stableWindows = this._getMonitorWindowsStable(app);
        const focusIdx = focusWin ? stableWindows.indexOf(focusWin) : -1;
        const isFocused = focusIdx !== -1;

        const btn = new St.Button({
            style_class: isFocused ? 'clean-dock-item focused' : 'clean-dock-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
        });

        const col = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const iconStack = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            width: iconSize,
            height: iconSize,
        });
        const icon = app.create_icon_texture(iconSize);
        iconStack.add_child(icon);

        const badgeLabel = new St.Label({
            style_class: 'clean-dock-badge-label',
            text: '',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const badgeBin = new St.Bin({
            style_class: 'clean-dock-badge',
            child: badgeLabel,
            visible: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        iconStack.add_child(badgeBin);

        col.add_child(iconStack);

        const dotsBox = new St.BoxLayout({
            style_class: 'clean-dock-dots',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        col.add_child(dotsBox);

        btn.set_child(col);

        const showDots = this._settings.get_boolean('show-running-dots');
        const dotCount = showDots ? Math.min(stableWindows.length, 4) : 0;
        const focusedDot = isFocused && dotCount > 0 ? Math.min(focusIdx, dotCount - 1) : -1;

        const item = {
            app,
            btn,
            dotsBox,
            badgeBin,
            badgeLabel,
            isFocused,
            dotCount: -1,
            focusedDot: -2,
            notifCount: -1,
        };
        this._updateItemDots(item, dotCount, focusedDot);
        this._updateItemBadge(item, this._notifications.getCount(app.get_id()));

        btn.connect('clicked', (_actor, clickedButton) => {
            if (clickedButton === Clutter.BUTTON_MIDDLE) {
                if (Main.overview.visible)
                    Main.overview.hide();
                if (app.can_open_new_window())
                    app.open_new_window(-1);
                else
                    app.activate();
                return;
            }
            this._activateApp(app);
        });

        btn.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._openAppMenu(btn, app);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        btn.connect('popup-menu', () => {
            this._openAppMenu(btn, app);
        });

        btn.connect('scroll-event', (_actor, event) => this._onItemScroll(app, event));

        btn.connect('notify::hover', () => {
            if (btn.hover && !this._menuOpen)
                this._showTooltip(btn, app.get_name());
            else
                this._hideTooltip();
        });

        return item;
    }

    _onItemScroll(app, event) {
        if (!this._settings.get_boolean('scroll-switch-windows'))
            return Clutter.EVENT_PROPAGATE;

        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            delta = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            delta = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            const step = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            this._scrollAccum += step;
            if (Math.abs(this._scrollAccum) >= 1.0) {
                delta = this._scrollAccum > 0 ? 1 : -1;
                this._scrollAccum = 0;
            }
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }

        if (delta !== 0) {
            const nowUs = GLib.get_monotonic_time();
            if (nowUs - this._lastScrollUs >= SCROLL_COOLDOWN_US) {
                this._lastScrollUs = nowUs;
                this._scrollAccum = 0;
                this._cycleAppWindows(app, delta);
            }
        }
        return Clutter.EVENT_STOP;
    }

    _launchApp(app) {
        if (app.get_n_windows() === 0)
            app.activate();
        else if (app.can_open_new_window())
            app.open_new_window(-1);
        else
            app.activate();
    }

    _activateApp(app) {
        const wasInOverview = Main.overview.visible;
        if (wasInOverview)
            Main.overview.hide();

        const mruWindows = this._getMonitorWindowsMRU(app);
        if (mruWindows.length === 0) {
            this._launchApp(app);
            return;
        }

        const focusWin = global.display.get_focus_window();
        if (wasInOverview || !focusWin || !mruWindows.includes(focusWin) || focusWin.minimized) {
            Main.activateWindow(mruWindows[0]);
            return;
        }

        const clickAction = this._settings.get_string('click-action');
        if (clickAction === 'activate') {
            Main.activateWindow(focusWin);
            return;
        }

        if (clickAction === 'minimize') {
            for (const win of mruWindows) {
                if (!win.minimized)
                    win.minimize();
            }
            return;
        }

        if (mruWindows.length === 1) {
            focusWin.minimize();
            return;
        }

        this._cycleAppWindows(app, 1);
    }

    _cycleAppWindows(app, delta) {
        const windows = this._getMonitorWindowsStable(app);
        if (windows.length === 0)
            return;

        if (Main.overview.visible)
            Main.overview.hide();

        const focusWin = global.display.get_focus_window();
        const curIdx = focusWin ? windows.indexOf(focusWin) : -1;
        if (curIdx === -1) {
            const mru = this._getMonitorWindowsMRU(app);
            Main.activateWindow(mru[0] ?? windows[0]);
            return;
        }

        const nextIdx = (curIdx + delta + windows.length) % windows.length;
        Main.activateWindow(windows[nextIdx]);
    }

    _openAppMenu(sourceActor, app) {
        if (this._destroyed || !sourceActor?.get_stage())
            return;

        this._hideTooltip();
        this._closeActiveMenu();

        const menu = new AppMenu.AppMenu(sourceActor, St.Side.BOTTOM, {
            favoritesSection: true,
            showSingleWindows: true,
        });
        menu.setApp(app);

        const appId = app.get_id();
        const notifCount = this._notifications.getCount(appId);
        if (notifCount > 0) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(`Clear Notifications (${notifCount})`, () => {
                this._notifications.clearApp(appId);
            });
        }

        Main.uiGroup.add_child(menu.actor);
        if (!this._menuManager)
            this._menuManager = new PopupMenu.PopupMenuManager(this._pill);
        this._menuManager.addMenu(menu);

        this._activeMenu = menu;
        this._menuOpen = true;
        this._updateVisibility();

        this._activeMenuOpenId = menu.connect('open-state-changed', (_m, isOpen) => {
            if (isOpen)
                return;

            if (this._activeMenuOpenId) {
                menu.disconnect(this._activeMenuOpenId);
                this._activeMenuOpenId = 0;
            }
            this._menuOpen = false;
            if (this._activeMenu === menu)
                this._activeMenu = null;

            if (this._menuDestroyId)
                GLib.Source.remove(this._menuDestroyId);
            this._menuDestroyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._menuDestroyId = 0;
                this._menuManager?.removeMenu(menu);
                menu.destroy();
                return GLib.SOURCE_REMOVE;
            });

            this._pill?.sync_hover();
            this._trigger?.sync_hover();
            this._syncHoverState();
            this._updateVisibility();
        });

        menu.open();
    }

    _closeActiveMenu() {
        if (this._menuDestroyId) {
            GLib.Source.remove(this._menuDestroyId);
            this._menuDestroyId = 0;
        }
        if (!this._activeMenu)
            return;

        const m = this._activeMenu;
        const sigId = this._activeMenuOpenId;
        this._activeMenu = null;
        this._activeMenuOpenId = 0;
        this._menuOpen = false;

        // Disconnect before m.close() so open-state-changed does not queue a second destroy.
        if (sigId)
            m.disconnect(sigId);

        m.close(false);
        this._menuManager?.removeMenu(m);
        m.destroy();
    }

    _showTooltip(anchor, text) {
        if (
            this._destroyed ||
            !text ||
            !this._settings.get_boolean('show-tooltips') ||
            !anchor?.get_stage() ||
            !this._tooltip?.get_stage()
        ) {
            this._hideTooltip();
            return;
        }

        this._tooltip.text = String(text);
        this._tooltip.show();

        const [ax, ay] = anchor.get_transformed_position();
        const [aw] = anchor.get_transformed_size();
        const [, lw] = this._tooltip.get_preferred_width(-1);
        const [, lh] = this._tooltip.get_preferred_height(-1);

        const x = Math.max(
            this._monitor.x + 6,
            Math.min(
                this._monitor.x + this._monitor.width - lw - 6,
                Math.floor(ax + (aw - lw) / 2)
            )
        );
        const y = Math.floor(ay - lh - 10);
        this._tooltip.set_position(x, y);
    }

    _hideTooltip() {
        this._tooltip?.hide();
    }

    _syncHoverState() {
        if (this._destroyed)
            return;
        const hovered = Boolean(this._pill?.hover || this._trigger?.hover);
        this._setHovered(hovered);
    }

    _setHovered(hovered) {
        if (this._hideTimeoutId) {
            GLib.Source.remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }

        if (hovered) {
            if (!this._hovered) {
                this._hovered = true;
                this._updateVisibility();
            }
            return;
        }

        const delayMs = this._settings.get_int('hide-delay-ms');
        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._hideTimeoutId = 0;
            if (this._destroyed || !this._pill)
                return GLib.SOURCE_REMOVE;
            this._hovered = Boolean(this._pill.hover || this._trigger?.hover);
            this._updateVisibility();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateVisibility() {
        if (this._destroyed || !this._root?.get_stage() || !this._pill || !this._intellihide)
            return;

        const inOverview = Main.overview.visible || Main.overview.visibleTarget;
        const intellihideEnabled = this._settings.get_boolean('intellihide');
        const isOverlapping = intellihideEnabled && this._intellihide.overlaps;

        if (this._trigger)
            this._trigger.visible = isOverlapping && !inOverview && this._pill.visible;

        const shouldHide =
            !inOverview &&
            !this._hovered &&
            !this._menuOpen &&
            isOverlapping;

        const dynTrans = this._settings.get_boolean('dynamic-transparency');
        const solid = !dynTrans || inOverview || this._intellihide.overlaps || this._intellihide.hasMaximized;
        const opacityPct = solid
            ? this._settings.get_int('solid-opacity')
            : this._settings.get_int('transparent-opacity');
        const nextStyleKey = `${solid ? 's' : 't'}:${opacityPct}`;

        if (nextStyleKey !== this._styleKey) {
            this._styleKey = nextStyleKey;
            if (solid) {
                this._pill.add_style_class_name('solid');
                this._pill.remove_style_class_name('transparent');
            } else {
                this._pill.add_style_class_name('transparent');
                this._pill.remove_style_class_name('solid');
            }
            const alpha = (opacityPct / 100).toFixed(2);
            this._pill.set_style(`background-color: rgba(24, 24, 28, ${alpha});`);
        }

        if (shouldHide === this._hidden)
            return;

        this._hidden = shouldHide;
        if (shouldHide)
            this._hideTooltip();

        // Exclude auto-hidden dock from Clutter pointer picking while preserving layout sizing.
        Shell.util_set_hidden_from_pick(this._root, shouldHide);

        const height = this._dockRect?.height ?? this._root.height;
        const slideOffset = shouldHide ? (height + 16) : 0;

        this._root.remove_all_transitions();
        if (!this._initialized) {
            this._root.translation_y = slideOffset;
            this._root.opacity = shouldHide ? 0 : 255;
            return;
        }

        this._root.ease({
            translation_y: slideOffset,
            opacity: shouldHide ? 0 : 255,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _cancelPendingSources() {
        if (this._hideTimeoutId) {
            GLib.Source.remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
        if (this._rebuildId) {
            GLib.Source.remove(this._rebuildId);
            this._rebuildId = 0;
        }
        if (this._stateUpdateId) {
            GLib.Source.remove(this._stateUpdateId);
            this._stateUpdateId = 0;
        }
        if (this._menuDestroyId) {
            GLib.Source.remove(this._menuDestroyId);
            this._menuDestroyId = 0;
        }
    }

    destroy(actorsAlreadyDisposing = false) {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._cancelPendingSources();
        if (!actorsAlreadyDisposing)
            this._closeActiveMenu();
        else {
            if (this._activeMenuOpenId && this._activeMenu) {
                try {
                    this._activeMenu.disconnect(this._activeMenuOpenId);
                } catch {
                    // Already disposed.
                }
            }
            this._activeMenuOpenId = 0;
            this._activeMenu = null;
            this._menuOpen = false;
        }
        this._items.clear();

        if (this._unsubNotif) {
            this._unsubNotif();
            this._unsubNotif = null;
        }

        for (const [obj, id] of this._signals) {
            try {
                obj.disconnect(id);
            } catch {
                // Already disposed during shell shutdown.
            }
        }
        this._signals = [];

        if (!actorsAlreadyDisposing) {
            if (this._pillHoverId && this._pill) {
                this._pill.disconnect(this._pillHoverId);
                this._pillHoverId = 0;
            }
            if (this._triggerHoverId && this._trigger) {
                this._trigger.disconnect(this._triggerHoverId);
                this._triggerHoverId = 0;
            }
        } else {
            this._pillHoverId = 0;
            this._triggerHoverId = 0;
        }

        this._intellihide?.destroy();
        this._intellihide = null;
        this._menuManager = null;

        if (!actorsAlreadyDisposing) {
            if (this._tooltip) {
                Main.layoutManager.removeChrome(this._tooltip);
                this._tooltip.destroy();
            }
            if (this._trigger) {
                Main.layoutManager.removeChrome(this._trigger);
                this._trigger.destroy();
            }
            if (this._root) {
                this._root.remove_all_transitions();
                Main.layoutManager.removeChrome(this._root);
                this._root.destroy();
            }
        }
        this._tooltip = null;
        this._trigger = null;
        this._root = null;
        this._pill = null;
        this._iconsBox = null;
        this._separator = null;
        this._settings = null;
    }
}

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export class NotificationsMonitor {
    constructor(extensionSettings) {
        this._extSettings = extensionSettings;
        this._listeners = new Set();
        this._trayCounts = new Map();
        // sender bus name -> { appId, count, visible }
        this._unityEntries = new Map();
        this._unityCounts = new Map();
        this._sourceSignals = new Map();
        this._notifSignals = new Map();
        this._appIdCache = new Map();
        this._refreshIdleId = 0;
        this._destroyed = false;

        this._appSystem = Shell.AppSystem.get_default();
        this._installedChangedId = this._appSystem.connect('installed-changed', () => {
            this._appIdCache.clear();
        });

        this._notifSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications',
        });
        this._dnd = !this._notifSettings.get_boolean('show-banners');
        this._notifSettingsId = this._notifSettings.connect('changed::show-banners', () => {
            this._dnd = !this._notifSettings.get_boolean('show-banners');
            this._refreshTray(true);
        });

        this._badgesEnabled = this._extSettings.get_boolean('show-notification-badges');
        this._extSettingsId = this._extSettings.connect('changed::show-notification-badges', () => {
            this._badgesEnabled = this._extSettings.get_boolean('show-notification-badges');
            this._emitChanged(null);
        });

        this._trayAddedId = Main.messageTray.connect('source-added', () => this._scheduleRefreshTray());
        this._trayRemovedId = Main.messageTray.connect('source-removed', () => this._scheduleRefreshTray());

        // Unity LauncherEntry signals carry live unread counts from Discord, Slack, Steam, and Electron apps.
        this._unitySubId = Gio.DBus.session.signal_subscribe(
            null,
            'com.canonical.Unity.LauncherEntry',
            'Update',
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, sender, _path, _iface, _signal, params) => {
                this._onUnityUpdate(sender, params);
            }
        );

        // Clear Unity counts when a sender disconnects from the session bus without resetting its badge.
        this._nameOwnerSubId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                if (this._destroyed)
                    return;
                const [name, oldOwner, newOwner] = params.deep_unpack();
                if (oldOwner && !newOwner && this._unityEntries.has(name)) {
                    const entry = this._unityEntries.get(name);
                    this._unityEntries.delete(name);
                    this._updateUnityCountForApp(entry.appId);
                    this._emitChanged(entry.appId);
                }
            }
        );

        this._refreshTray(false);
    }

    onChanged(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    getCount(appId) {
        if (this._destroyed || this._dnd || !this._badgesEnabled || !appId)
            return 0;

        // Unity LauncherEntry overrides messageTray (including 0) so read chats clear immediately.
        if (this._unityCounts.has(appId))
            return this._unityCounts.get(appId);

        return this._trayCounts.get(appId) ?? 0;
    }

    clearApp(appId) {
        if (this._destroyed || !appId)
            return;

        for (const entry of this._unityEntries.values()) {
            if (entry.appId === appId) {
                entry.count = 0;
                entry.visible = false;
            }
        }
        this._updateUnityCountForApp(appId);

        const dismissReason = MessageTray.NotificationDestroyedReason?.DISMISSED;
        for (const source of Main.messageTray.getSources()) {
            if (!source?.notifications)
                continue;
            for (const notif of [...source.notifications]) {
                if (this._getNotificationAppId(notif, source) === appId) {
                    try {
                        notif.destroy(dismissReason);
                    } catch {
                        // Notification already disposed.
                    }
                }
            }
        }

        this._trayCounts.delete(appId);
        this._emitChanged(appId);
    }

    _resolveAppId(rawId) {
        if (!rawId)
            return null;

        const cached = this._appIdCache.get(rawId);
        if (cached !== undefined)
            return cached;

        const withSuffix = rawId.endsWith('.desktop') ? rawId : `${rawId}.desktop`;
        const app =
            this._appSystem.lookup_app(rawId) ??
            this._appSystem.lookup_app(withSuffix) ??
            this._appSystem.lookup_heuristic_basename(withSuffix) ??
            this._appSystem.lookup_desktop_wmclass(rawId);

        const resolved = app?.get_id?.() ?? withSuffix;
        this._appIdCache.set(rawId, resolved);
        return resolved;
    }

    _getNotificationAppId(notif, source) {
        const app = notif?.source?.app ?? notif?.source?._app ?? source?.app ?? source?._app;
        const directId = app?.get_id?.() ?? app?.id ?? app?._appId;
        if (directId)
            return this._resolveAppId(directId);
        return null;
    }

    _updateUnityCountForApp(appId) {
        if (!appId)
            return;
        let hasSender = false;
        let total = 0;
        for (const entry of this._unityEntries.values()) {
            if (entry.appId === appId) {
                hasSender = true;
                if (entry.visible && entry.count > 0)
                    total += entry.count;
            }
        }
        if (hasSender)
            this._unityCounts.set(appId, total);
        else
            this._unityCounts.delete(appId);
    }

    _onUnityUpdate(sender, params) {
        if (this._destroyed)
            return;
        try {
            const [appUri, props] = params.deep_unpack();
            if (!appUri || !appUri.startsWith('application://'))
                return;

            const rawId = decodeURIComponent(appUri.slice('application://'.length)).replace(/^\/+/, '');
            const appId = this._resolveAppId(rawId);
            if (!appId)
                return;

            const prev = this._unityEntries.get(sender);
            const prevAppId = prev?.appId;
            const prevCount = prev?.count ?? 0;
            const prevVisible = prev?.visible ?? false;

            const nextCount = 'count' in props
                ? Math.max(0, Number(props['count'].deep_unpack()) || 0)
                : prevCount;
            const nextVisible = 'count-visible' in props
                ? Boolean(props['count-visible'].deep_unpack())
                : prevVisible;

            if (prev && prevAppId === appId && prevCount === nextCount && prevVisible === nextVisible)
                return;

            this._unityEntries.set(sender, {
                appId,
                count: nextCount,
                visible: nextVisible,
            });

            if (prevAppId && prevAppId !== appId) {
                this._updateUnityCountForApp(prevAppId);
                this._emitChanged(prevAppId);
            }
            this._updateUnityCountForApp(appId);
            this._emitChanged(appId);
        } catch {
            // Ignore malformed LauncherEntry D-Bus payloads.
        }
    }

    _scheduleRefreshTray() {
        if (this._destroyed || this._refreshIdleId)
            return;
        this._refreshIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshIdleId = 0;
            this._refreshTray(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _emitChanged(appId = null) {
        if (this._destroyed)
            return;
        for (const cb of this._listeners)
            cb(appId);
    }

    _clearSubSignals() {
        for (const [obj, ids] of this._sourceSignals) {
            for (const id of ids) {
                try {
                    obj.disconnect(id);
                } catch {
                    // Already disposed.
                }
            }
        }
        this._sourceSignals.clear();

        for (const [obj, ids] of this._notifSignals) {
            for (const id of ids) {
                try {
                    obj.disconnect(id);
                } catch {
                    // Already disposed.
                }
            }
        }
        this._notifSignals.clear();
    }

    _refreshTray(broadcastAll = false) {
        if (this._destroyed)
            return;

        this._clearSubSignals();
        const prevCounts = this._trayCounts;
        const nextCounts = new Map();

        if (!this._dnd) {
            const sources = Main.messageTray?.getSources?.() ?? [];
            for (const source of sources) {
                if (!source)
                    continue;

                // Avoid ::destroy on MessageTray GObjects; they finalize during GJS GC sweep on exit.
                try {
                    const addedId = source.connect('notification-added', () => this._scheduleRefreshTray());
                    const removedId = source.connect('notification-removed', () => this._scheduleRefreshTray());
                    this._sourceSignals.set(source, [addedId, removedId]);
                } catch {
                    // Source was already disposed before idle callback ran.
                    continue;
                }

                const notifications = source.notifications ?? [];
                for (const notif of notifications) {
                    if (!notif || notif.acknowledged || notif.isTransient)
                        continue;

                    const appId = this._getNotificationAppId(notif, source);
                    if (!appId)
                        continue;

                    try {
                        const ackId = notif.connect('notify::acknowledged', () => {
                            this._scheduleRefreshTray();
                        });
                        this._notifSignals.set(notif, [ackId]);
                    } catch {
                        continue;
                    }

                    nextCounts.set(appId, (nextCounts.get(appId) ?? 0) + 1);
                }
            }
        }

        this._trayCounts = nextCounts;

        if (broadcastAll) {
            this._emitChanged(null);
            return;
        }

        const changedIds = new Set([...prevCounts.keys(), ...nextCounts.keys()]);
        for (const appId of changedIds) {
            if ((prevCounts.get(appId) ?? 0) !== (nextCounts.get(appId) ?? 0))
                this._emitChanged(appId);
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._refreshIdleId) {
            GLib.Source.remove(this._refreshIdleId);
            this._refreshIdleId = 0;
        }

        this._clearSubSignals();

        if (this._unitySubId) {
            Gio.DBus.session.signal_unsubscribe(this._unitySubId);
            this._unitySubId = 0;
        }
        if (this._nameOwnerSubId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerSubId);
            this._nameOwnerSubId = 0;
        }
        if (this._installedChangedId && this._appSystem) {
            this._appSystem.disconnect(this._installedChangedId);
            this._installedChangedId = 0;
        }
        if (this._notifSettingsId && this._notifSettings) {
            this._notifSettings.disconnect(this._notifSettingsId);
            this._notifSettingsId = 0;
        }
        if (this._extSettingsId && this._extSettings) {
            this._extSettings.disconnect(this._extSettingsId);
            this._extSettingsId = 0;
        }
        if (this._trayAddedId) {
            try {
                Main.messageTray?.disconnect(this._trayAddedId);
            } catch {
                // Already disposed during shell shutdown.
            }
            this._trayAddedId = 0;
        }
        if (this._trayRemovedId) {
            try {
                Main.messageTray?.disconnect(this._trayRemovedId);
            } catch {
                // Already disposed during shell shutdown.
            }
            this._trayRemovedId = 0;
        }

        this._listeners.clear();
        this._trayCounts.clear();
        this._unityEntries.clear();
        this._unityCounts.clear();
        this._appIdCache.clear();
        this._notifSettings = null;
        this._extSettings = null;
        this._appSystem = null;
    }
}

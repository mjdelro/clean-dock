import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MonitorDock} from './dock.js';
import {NotificationsMonitor} from './notifications.js';

export default class CleanDockExtension extends Extension {
    enable() {
        this._docks = [];
        this._closing = false;
        this._settings = this.getSettings();
        this._notifications = new NotificationsMonitor(this._settings);

        const dash = Main.overview?.dash;
        if (dash) {
            dash.hide();
            dash.set_height(0);
            this._dashVisibleId = dash.connect('notify::visible', () => {
                if (!this._closing && dash.visible)
                    dash.hide();
            });
        }

        // Tear down as soon as Main.uiGroup or the compositor starts shutting down.
        this._uiGroupDestroyId = Main.uiGroup.connect('destroy', () => {
            this._closing = true;
            this._uiGroupDestroyId = 0;
            this._teardown(true);
        });

        this._prepareShutdownId = global.context?.connect?.('prepare-shutdown', () => {
            this._closing = true;
            this._teardown(true);
        }) ?? 0;

        this._displayClosingId = global.display.connect('closing', () => {
            this._closing = true;
            this._teardown(true);
        });

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => this._rebuildDocks()
        );

        if (Main.layoutManager._startingUp) {
            this._startupCompleteId = Main.layoutManager.connect(
                'startup-complete',
                () => {
                    if (this._startupCompleteId) {
                        Main.layoutManager.disconnect(this._startupCompleteId);
                        this._startupCompleteId = 0;
                    }
                    this._rebuildDocks();
                }
            );
        }

        this._multiMonitorChangedId = this._settings.connect(
            'changed::multi-monitor',
            () => this._rebuildDocks()
        );

        this._rebuildDocks();
    }

    _rebuildDocks() {
        if (this._closing || !this._settings)
            return;

        this._destroyDocks(false);

        const monitors = Main.layoutManager.monitors;
        if (!monitors || monitors.length === 0)
            return;

        if (this._settings.get_boolean('multi-monitor')) {
            for (let i = 0; i < monitors.length; i++)
                this._docks.push(new MonitorDock(i, this._notifications, this._settings));
        } else {
            const primary = Main.layoutManager.primaryIndex;
            if (primary >= 0 && primary < monitors.length)
                this._docks.push(new MonitorDock(primary, this._notifications, this._settings));
        }
    }

    _destroyDocks(actorsAlreadyDisposing = false) {
        if (!this._docks)
            return;
        for (const dock of this._docks)
            dock.destroy(actorsAlreadyDisposing);
        this._docks = [];
    }

    _teardown(isShellClosing = false) {
        if (this._uiGroupDestroyId && Main.uiGroup) {
            try {
                Main.uiGroup.disconnect(this._uiGroupDestroyId);
            } catch {
                // Already disposing.
            }
            this._uiGroupDestroyId = 0;
        }
        if (this._prepareShutdownId && global.context) {
            global.context.disconnect(this._prepareShutdownId);
            this._prepareShutdownId = 0;
        }
        if (this._displayClosingId) {
            global.display.disconnect(this._displayClosingId);
            this._displayClosingId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._startupCompleteId) {
            Main.layoutManager.disconnect(this._startupCompleteId);
            this._startupCompleteId = 0;
        }
        if (this._multiMonitorChangedId && this._settings) {
            this._settings.disconnect(this._multiMonitorChangedId);
            this._multiMonitorChangedId = 0;
        }
        if (this._dashVisibleId) {
            try {
                Main.overview?.dash?.disconnect(this._dashVisibleId);
            } catch {
                // Dash may already be disposed on shell shutdown.
            }
            this._dashVisibleId = 0;
        }

        this._destroyDocks(isShellClosing);

        this._notifications?.destroy();
        this._notifications = null;
        this._settings = null;

        if (!isShellClosing) {
            Main.overview?.dash?.set_height(-1);
            Main.overview?.dash?.show();
        }
    }

    disable() {
        this._teardown(this._closing);
    }
}

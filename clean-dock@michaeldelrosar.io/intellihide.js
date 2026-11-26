import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const IGNORED_TYPES = new Set([
    Meta.WindowType.DESKTOP,
    Meta.WindowType.DOCK,
    Meta.WindowType.SPLASHSCREEN,
    Meta.WindowType.OVERRIDE_OTHER,
]);

export class IntellihideMonitor {
    constructor(monitorIndex, getDockRect, onStateChanged) {
        this._monitorIndex = monitorIndex;
        this._getDockRect = getDockRect;
        this._onStateChanged = onStateChanged;

        this._destroyed = false;
        this._overlaps = false;
        this._hasMaximized = false;
        this._debounceId = 0;
        this._windowSignals = new Map();
        this._windowsOnMonitor = new Set();

        this._displayIds = [
            global.display.connect('window-created', (_d, win) => {
                this._trackWindow(win);
                if (win.get_monitor() === this._monitorIndex)
                    this._scheduleCheck();
            }),
            global.display.connect('window-entered-monitor', (_d, monIdx, win) => {
                if (monIdx === this._monitorIndex) {
                    this._trackWindow(win);
                    this._scheduleCheck();
                }
            }),
            global.display.connect('window-left-monitor', (_d, monIdx) => {
                if (monIdx === this._monitorIndex)
                    this._scheduleCheck();
            }),
            global.display.connect('restacked', () => this._scheduleCheck()),
            global.display.connect('in-fullscreen-changed', () => this._scheduleCheck()),
        ];

        this._wsId = global.workspace_manager.connect(
            'active-workspace-changed',
            () => this._scheduleCheck()
        );

        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win)
                this._trackWindow(win);
        }

        this._checkNow(false);
    }

    get overlaps() {
        return this._overlaps;
    }

    get hasMaximized() {
        return this._hasMaximized;
    }

    recheck(notify = false) {
        if (!this._destroyed)
            this._checkNow(notify);
    }

    _onWindowGeometryOrStateChanged(win) {
        if (this._destroyed)
            return;
        if (win.get_monitor() === this._monitorIndex || this._windowsOnMonitor.has(win))
            this._scheduleCheck();
    }

    _trackWindow(win) {
        if (this._destroyed || !win || this._windowSignals.has(win))
            return;
        if (IGNORED_TYPES.has(win.get_window_type()))
            return;

        try {
            const onChange = () => this._onWindowGeometryOrStateChanged(win);
            const ids = [
                win.connect('position-changed', onChange),
                win.connect('size-changed', onChange),
                win.connect('notify::minimized', onChange),
                win.connect('notify::maximized-horizontally', onChange),
                win.connect('notify::maximized-vertically', onChange),
                win.connect('workspace-changed', onChange),
                win.connect('unmanaged', () => {
                    const wasOnMonitor = this._windowsOnMonitor.delete(win);
                    this._untrackWindow(win);
                    if (wasOnMonitor)
                        this._scheduleCheck();
                }),
            ];
            this._windowSignals.set(win, ids);
        } catch {
            // Window may already be disposed during rapid teardown.
        }
    }

    _untrackWindow(win) {
        const ids = this._windowSignals.get(win);
        if (!ids)
            return;
        this._windowSignals.delete(win);
        for (const id of ids) {
            try {
                win.disconnect(id);
            } catch {
                // Already disposed.
            }
        }
    }

    _scheduleCheck() {
        if (this._destroyed || this._debounceId)
            return;
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._debounceId = 0;
            this._checkNow(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkNow(notify = true) {
        if (this._destroyed)
            return;

        const activeWs = global.workspace_manager.get_active_workspace();
        const dockRect = this._getDockRect();
        const nextWindowsOnMonitor = new Set();
        let overlaps = false;
        let hasMaximized = false;

        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win || win.get_monitor() !== this._monitorIndex)
                continue;

            nextWindowsOnMonitor.add(win);

            if (win.minimized || win.is_skip_taskbar())
                continue;
            if (IGNORED_TYPES.has(win.get_window_type()))
                continue;
            if (!win.located_on_workspace(activeWs))
                continue;

            if (win.is_fullscreen()) {
                overlaps = true;
                hasMaximized = true;
                continue;
            }

            if (win.is_maximized() || (win.maximized_horizontally && win.maximized_vertically))
                hasMaximized = true;

            if (!overlaps && dockRect) {
                const r = win.get_frame_rect();
                if (
                    r.x < dockRect.x + dockRect.width &&
                    r.x + r.width > dockRect.x &&
                    r.y < dockRect.y + dockRect.height &&
                    r.y + r.height > dockRect.y
                )
                    overlaps = true;
            }
        }

        this._windowsOnMonitor = nextWindowsOnMonitor;

        if (overlaps !== this._overlaps || hasMaximized !== this._hasMaximized) {
            this._overlaps = overlaps;
            this._hasMaximized = hasMaximized;
            if (notify)
                this._onStateChanged();
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._debounceId) {
            GLib.Source.remove(this._debounceId);
            this._debounceId = 0;
        }

        for (const id of this._displayIds) {
            try {
                global.display.disconnect(id);
            } catch {
                // Display already closing.
            }
        }
        this._displayIds = [];

        if (this._wsId) {
            try {
                global.workspace_manager.disconnect(this._wsId);
            } catch {
                // Workspace manager already disposed.
            }
            this._wsId = 0;
        }

        for (const win of [...this._windowSignals.keys()])
            this._untrackWindow(win);
        this._windowsOnMonitor.clear();
    }
}

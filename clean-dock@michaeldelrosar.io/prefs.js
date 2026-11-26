import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CLICK_ACTIONS = ['cycle', 'minimize', 'activate'];

export default class CleanDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_title('Clean Dock');
        window.set_default_size(580, 660);

        const page = new Adw.PreferencesPage({
            title: 'Clean Dock',
            icon_name: 'preferences-desktop-apps-symbolic',
        });
        window.add(page);

        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Configure dock size, spacing, and pill background opacity',
        });
        page.add(appearanceGroup);

        const iconSizeRow = new Adw.SpinRow({
            title: 'Maximum Icon Size (px)',
            subtitle: 'Automatically scales down if too many apps are open',
            adjustment: new Gtk.Adjustment({
                lower: 28,
                upper: 72,
                step_increment: 2,
                page_increment: 8,
            }),
        });
        settings.bind('icon-size', iconSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(iconSizeRow);

        const bottomMarginRow = new Adw.SpinRow({
            title: 'Bottom Margin (px)',
            subtitle: 'Gap between the dock pill and the bottom edge of the monitor',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 24,
                step_increment: 1,
                page_increment: 4,
            }),
        });
        settings.bind('bottom-margin', bottomMarginRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(bottomMarginRow);

        const dynTransRow = new Adw.SwitchRow({
            title: 'Dynamic Transparency',
            subtitle: 'Translucent when unobstructed; solid in Overview or over windows',
        });
        settings.bind('dynamic-transparency', dynTransRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(dynTransRow);

        const clearOpacityRow = new Adw.SpinRow({
            title: 'Clear Opacity (%)',
            subtitle: 'Background opacity when no window touches the dock',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
            }),
        });
        settings.bind('transparent-opacity', clearOpacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('dynamic-transparency', clearOpacityRow, 'sensitive', Gio.SettingsBindFlags.GET);
        appearanceGroup.add(clearOpacityRow);

        const solidOpacityRow = new Adw.SpinRow({
            title: 'Solid Opacity (%)',
            subtitle: 'Background opacity in Overview or when windows overlap',
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 100,
                step_increment: 2,
                page_increment: 10,
            }),
        });
        settings.bind('solid-opacity', solidOpacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(solidOpacityRow);

        const behaviorGroup = new Adw.PreferencesGroup({
            title: 'Behavior and Monitors',
            description: 'Configure intellihide, multi-monitor isolation, and window switching',
        });
        page.add(behaviorGroup);

        const intellihideRow = new Adw.SwitchRow({
            title: 'Intellihide',
            subtitle: 'Slide away when overlapped by windows and reveal on bottom-edge hover',
        });
        settings.bind('intellihide', intellihideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(intellihideRow);

        const hideDelayRow = new Adw.SpinRow({
            title: 'Hide Delay (ms)',
            subtitle: 'Time before sliding out after the pointer leaves the dock',
            adjustment: new Gtk.Adjustment({
                lower: 100,
                upper: 1000,
                step_increment: 20,
                page_increment: 100,
            }),
        });
        settings.bind('hide-delay-ms', hideDelayRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('intellihide', hideDelayRow, 'sensitive', Gio.SettingsBindFlags.GET);
        behaviorGroup.add(hideDelayRow);

        const multiMonitorRow = new Adw.SwitchRow({
            title: 'Show on All Monitors',
            subtitle: 'Render a dock on every connected display instead of primary only',
        });
        settings.bind('multi-monitor', multiMonitorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(multiMonitorRow);

        const isolateMonitorsRow = new Adw.SwitchRow({
            title: 'Isolate Windows per Monitor',
            subtitle: 'Only list running apps and window dots present on each dock\'s monitor',
        });
        settings.bind('isolate-monitors', isolateMonitorsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(isolateMonitorsRow);

        const isolateWorkspacesRow = new Adw.SwitchRow({
            title: 'Isolate Windows per Workspace',
            subtitle: 'Filter running apps and window dots to the active workspace',
        });
        settings.bind('isolate-workspaces', isolateWorkspacesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(isolateWorkspacesRow);

        const clickActionModel = Gtk.StringList.new([
            'Cycle Windows / Minimize Single',
            'Minimize Windows',
            'Keep Focused',
        ]);
        const clickActionRow = new Adw.ComboRow({
            title: 'Focused App Click Action',
            subtitle: 'Behavior when clicking an app that already holds focus',
            model: clickActionModel,
        });
        const syncComboFromSettings = () => {
            const idx = CLICK_ACTIONS.indexOf(settings.get_string('click-action'));
            const validIdx = idx >= 0 ? idx : 0;
            if (clickActionRow.selected !== validIdx)
                clickActionRow.selected = validIdx;
        };
        syncComboFromSettings();
        clickActionRow.connect('notify::selected', () => {
            const next = CLICK_ACTIONS[clickActionRow.selected] ?? 'cycle';
            if (settings.get_string('click-action') !== next)
                settings.set_string('click-action', next);
        });
        const clickChangedId = settings.connect('changed::click-action', syncComboFromSettings);
        window.connect('close-request', () => {
            settings.disconnect(clickChangedId);
            return false;
        });
        behaviorGroup.add(clickActionRow);

        const scrollSwitchRow = new Adw.SwitchRow({
            title: 'Scroll to Cycle Windows',
            subtitle: 'Use mouse wheel or touchpad scroll over an icon to switch windows',
        });
        settings.bind('scroll-switch-windows', scrollSwitchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(scrollSwitchRow);

        const indicatorsGroup = new Adw.PreferencesGroup({
            title: 'Indicators',
            description: 'Configure badges, window dots, and tooltips',
        });
        page.add(indicatorsGroup);

        const badgesRow = new Adw.SwitchRow({
            title: 'Notification Badges',
            subtitle: 'Show unread counts from GNOME Message Tray and Unity LauncherEntry',
        });
        settings.bind('show-notification-badges', badgesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        indicatorsGroup.add(badgesRow);

        const dotsRow = new Adw.SwitchRow({
            title: 'Running Window Dots',
            subtitle: 'Show up to 4 indicator dots beneath running apps, highlighting the focused window',
        });
        settings.bind('show-running-dots', dotsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        indicatorsGroup.add(dotsRow);

        const tooltipsRow = new Adw.SwitchRow({
            title: 'App Name Tooltips',
            subtitle: 'Show the application name when hovering over an icon',
        });
        settings.bind('show-tooltips', tooltipsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        indicatorsGroup.add(tooltipsRow);
    }
}

// java.util.prefs kept in memory (Phase 0 spike S7; Phase 2: desktop/engine-shim/).
//
// Suwayomi still calls java.util.prefs once at boot (Migration.kt: Preferences.userRoot().nodeExists(
// "suwayomi/tachidesk"), a migration from the old Tachidesk storage that MOVES what it finds and then calls
// removeNode()). With the platform factory that reaches outside the engine's data directory: the Windows
// registry (HKCU\Software\JavaSoft\Prefs), a plist in ~/Library/Preferences on macOS, ~/.java on Linux -- and
// on a PC that also has an old standalone Tachidesk it would import and delete THAT install's settings.
// Launched with -Djava.util.prefs.PreferencesFactory=dev.uchiyomi.IsolatedPreferences$Factory the engine
// sees an empty, private tree instead.
package dev.uchiyomi;

import java.util.HashMap;
import java.util.Map;
import java.util.prefs.AbstractPreferences;
import java.util.prefs.Preferences;
import java.util.prefs.PreferencesFactory;

public final class IsolatedPreferences extends AbstractPreferences {
    private final Map<String, String> values = new HashMap<>();
    private final Map<String, IsolatedPreferences> children = new HashMap<>();

    private IsolatedPreferences(IsolatedPreferences parent, String name) {
        super(parent, name);
    }

    @Override protected void putSpi(String key, String value) { values.put(key, value); }
    @Override protected String getSpi(String key) { return values.get(key); }
    @Override protected void removeSpi(String key) { values.remove(key); }
    @Override protected void removeNodeSpi() { children.clear(); values.clear(); }
    @Override protected String[] keysSpi() { return values.keySet().toArray(new String[0]); }
    @Override protected String[] childrenNamesSpi() { return children.keySet().toArray(new String[0]); }
    @Override protected AbstractPreferences childSpi(String name) {
        return children.computeIfAbsent(name, n -> new IsolatedPreferences(this, n));
    }
    @Override protected void syncSpi() {}
    @Override protected void flushSpi() {}

    public static final class Factory implements PreferencesFactory {
        private static final Preferences USER = new IsolatedPreferences(null, "");
        private static final Preferences SYSTEM = new IsolatedPreferences(null, "");
        @Override public Preferences userRoot() { return USER; }
        @Override public Preferences systemRoot() { return SYSTEM; }
    }
}

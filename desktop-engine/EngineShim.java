// Uchiyomi Desktop -- the extension engine shim (Phase 0 spike S7; Phase 2 moves this to desktop/engine-shim/).
//
// The desktop shell starts Suwayomi-Server as `java ... -cp Suwayomi-Server.jar<sep>uchiyomi-shim.jar
// dev.uchiyomi.EngineShim`. This class does three things and then gets out of the way:
//
// 1. A lifeline. Windows has no graceful signal for a child process: Node's kill() is TerminateProcess, so the
//    JVM's shutdown hooks (Javalin stop, the HikariCP pool close that closes Suwayomi's H2 database) never run.
//    The shell keeps our stdin open instead. When stdin reaches EOF -- the shell closed it, OR the shell itself
//    died and the OS closed the pipe -- or a line reading `quit` arrives, we call System.exit(0), which runs
//    those hooks. The same mechanism means a crashed shell never leaves an orphan java.exe behind.
//
// 2. Values that must not travel on the command line are read from the environment and turned into the
//    system properties Suwayomi reads:
//      - paths: the Windows java launcher reads its command line through the ANSI code page, so a data
//        directory under a user profile like `C:\Users\Jösé 名前` arrives mangled (`?`), while
//        System.getenv() on Windows is UTF-16 and arrives intact;
//      - the engine's basic-auth credentials, which would otherwise be visible in any process listing.
//    A value already given with -D wins, so the shim never overrides an explicit flag.
//    On Windows the tmpdir must still be an ASCII path: JNA extracts its DLL there and HotSpot loads native
//    libraries through the ANSI code page too (measured: UnsatisfiedLinkError on "…\Jösé ??\…\jna….dll").
//    The runtime folder itself must be ASCII as well (java.exe under "Jösé 名前": "could not find java.dll").
//
// 3. It invokes the real main class. It is read from the Main-Class of the Suwayomi jar's manifest (for
//    v2.3.2243 that is `suwayomi.tachidesk.MainKt`); `-Duchiyomi.engine.mainClass=` overrides it.
//
// Suwayomi reads every `suwayomi.tachidesk.config.server.<key>` property through HOCON
// (SystemPropertyOverrideDelegate: ConfigFactory.parseString("internal=" + value)), so a value holding HOCON
// syntax (`#`, `${`, quotes, leading/trailing blanks) would be reinterpreted. Values this shim sets for
// HOCON-parsed keys are therefore written as quoted HOCON strings. rootDir is the exception: Suwayomi reads it
// raw with System.getProperty (ApplicationRootDir.kt). (A plain URL such as http://127.0.0.1:8191/x passed
// unquoted with -D was measured to arrive intact on v2.3.2243; the quoting is for everything else.)
//
// Compiled with `javac --release 21`; no dependencies.
package dev.uchiyomi;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.jar.Attributes;
import java.util.jar.JarFile;
import java.util.jar.Manifest;

public final class EngineShim {
    private static final String PREFIX = "suwayomi.tachidesk.config.server.";

    private EngineShim() {}

    public static void main(String[] args) throws Throwable {
        // Raw (not HOCON-parsed) keys first.
        fromEnv("UCHIYOMI_ENGINE_ROOT_DIR", PREFIX + "rootDir", false);
        // java.io.tmpdir: Suwayomi puts its temp root (extension staging, thumbnail cache, webUI-serve) at
        // ${java.io.tmpdir}/Tachidesk, shared with any other Suwayomi on the machine. Setting it here reaches
        // Suwayomi's ApplicationDirs, which reads the property directly; JDK-internal temp files keep the
        // startup value. The JVM always defines java.io.tmpdir, so this one overrides unconditionally.
        String tmp = System.getenv("UCHIYOMI_ENGINE_TMP_DIR");
        if (tmp != null && !tmp.isEmpty()) {
            new File(tmp).mkdirs();
            System.setProperty("java.io.tmpdir", tmp);
        }
        // HOCON-parsed keys.
        fromEnv("UCHIYOMI_ENGINE_AUTH_USERNAME", PREFIX + "authUsername", true);
        fromEnv("UCHIYOMI_ENGINE_AUTH_PASSWORD", PREFIX + "authPassword", true);
        fromEnv("UCHIYOMI_ENGINE_FLARESOLVERR_URL", PREFIX + "flareSolverrUrl", true);

        String root = System.getProperty(PREFIX + "rootDir");
        log("rootDir=" + (root == null ? "<default>" : escape(root)) + " tmpdir=" + escape(System.getProperty("java.io.tmpdir", ""))
            + " prefs=" + System.getProperty("java.util.prefs.PreferencesFactory", "<platform>"));

        Thread lifeline = new Thread(EngineShim::lifeline, "uchiyomi-engine-lifeline");
        lifeline.setDaemon(true);
        lifeline.start();

        if (Boolean.getBoolean("uchiyomi.shim.idle")) {
            // Test hook: the lifeline without the engine (used to probe how the process was created).
            log("idle mode; waiting for stdin to close");
            lifeline.join();
            return;
        }

        String mainClass = System.getProperty("uchiyomi.engine.mainClass");
        if (mainClass == null || mainClass.isBlank()) mainClass = mainClassFromClasspath();
        if (mainClass == null) {
            log("no Main-Class found on the classpath; pass -Duchiyomi.engine.mainClass");
            System.exit(78);
        }
        log("starting " + mainClass);
        invokeMain(mainClass, args);
    }

    /** Copy an environment variable into a system property unless -D already set it. */
    private static void fromEnv(String env, String property, boolean hoconQuote) {
        String value = System.getenv(env);
        if (value == null || value.isEmpty() || System.getProperty(property) != null) return;
        System.setProperty(property, hoconQuote ? hoconString(value) : value);
    }

    /** A HOCON quoted string: JSON string syntax. */
    static String hoconString(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }

    private static void lifeline() {
        String why = "stdin closed";
        try {
            InputStream in = System.in;
            StringBuilder line = new StringBuilder();
            int c;
            while ((c = in.read()) != -1) {
                if (c == '\n') {
                    if (line.toString().trim().equalsIgnoreCase("quit")) {
                        why = "quit requested";
                        break;
                    }
                    line.setLength(0);
                } else if (line.length() < 64) {
                    line.append((char) c);
                }
            }
        } catch (IOException e) {
            why = "stdin error: " + e.getMessage();
        }
        log(why + "; exiting so shutdown hooks close the database");
        System.exit(0);
    }

    /** The Main-Class of the first classpath jar that has one, skipping this shim's own jar. */
    private static String mainClassFromClasspath() {
        String cp = System.getProperty("java.class.path", "");
        for (String entry : cp.split(File.pathSeparator)) {
            if (entry.isBlank()) continue;
            File f = new File(entry);
            if (!f.isAbsolute()) f = new File(System.getProperty("user.dir"), entry);
            if (!f.isFile()) continue;
            try (JarFile jar = new JarFile(f)) {
                Manifest m = jar.getManifest();
                if (m == null) continue;
                String main = m.getMainAttributes().getValue(Attributes.Name.MAIN_CLASS);
                if (main == null || main.isBlank() || main.equals(EngineShim.class.getName())) continue;
                log("Main-Class " + main + " from " + f.getName());
                return main.trim();
            } catch (IOException ignored) {
                // not a jar we can read; keep looking
            }
        }
        return null;
    }

    private static void invokeMain(String className, String[] args) throws Throwable {
        Class<?> c = Class.forName(className, true, ClassLoader.getSystemClassLoader());
        Method m;
        Object[] callArgs;
        try {
            m = c.getMethod("main", String[].class);
            callArgs = new Object[] {args};
        } catch (NoSuchMethodException e) {
            // Kotlin's parameterless `fun main()`; normally it also emits a main(String[]) bridge.
            m = c.getDeclaredMethod("main");
            m.setAccessible(true);
            callArgs = new Object[0];
        }
        if (!Modifier.isStatic(m.getModifiers())) throw new IllegalStateException(className + ".main is not static");
        try {
            m.invoke(null, callArgs);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
    }

    /** Non-ASCII as \\uXXXX, so a mangled path is visible whatever encoding stdout uses. */
    static String escape(String s) {
        StringBuilder b = new StringBuilder();
        s.codePoints().forEach(cp -> {
            if (cp >= 0x20 && cp < 0x7f) b.append((char) cp);
            else if (cp <= 0xffff) b.append(String.format("\\u%04X", cp));
            else b.append(String.format("\\U%08X", cp));
        });
        return b.toString();
    }

    private static void log(String msg) {
        byte[] bytes = ("[uchiyomi-shim] " + msg + System.lineSeparator()).getBytes(StandardCharsets.US_ASCII);
        System.err.write(bytes, 0, bytes.length);
        System.err.flush();
    }
}

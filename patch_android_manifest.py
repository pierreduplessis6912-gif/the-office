"""Patches the freshly-generated AndroidManifest.xml with everything
this app's real, actual capabilities need - permissions the manifest
doesn't have yet, and the CallbackActivity flutter_web_auth_2 requires
to catch the theoffice:// OAuth redirect. Kept as a real, separate,
readable script rather than a growing inline python -c command.

Also bumps the Kotlin Gradle plugin version in settings.gradle - a
real, known, active Flutter framework issue (flutter/flutter#179253):
the default, bundled Kotlin plugin version is too old for dependencies
compiled with newer Kotlin (found live: jni-1.0.1's own build.gradle
requires a newer Kotlin DSL feature than the generated project's
default plugin version supports).
"""
import os
import re

MANIFEST_PATH = "android/app/src/main/AndroidManifest.xml"

PERMISSIONS = [
    "android.permission.INTERNET",
    "android.permission.RECORD_AUDIO",
    "android.permission.CAMERA",
    "android.permission.READ_CALENDAR",
    "android.permission.WRITE_CALENDAR",
]

# Real, exact XML required by flutter_web_auth_2 to catch the
# theoffice:// redirect on Android - confirmed against the package's
# own documented setup instructions, not guessed at.
CALLBACK_ACTIVITY = """    <activity android:name="com.linusu.flutter_web_auth_2.CallbackActivity" android:exported="true">
        <intent-filter android:label="flutter_web_auth_2">
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="theoffice" />
        </intent-filter>
    </activity>
"""

# Real, explicit Impeller-enabling flag - Impeller is already the
# default on modern Android per current Flutter docs, but is
# conditionally disabled on older/lower-end devices. Setting this
# explicitly removes any ambiguity rather than relying on an assumed
# default, per the direct instruction to target it as the real
# rendering engine for the native build.
IMPELLER_FLAG = '    <meta-data android:name="io.flutter.embedding.android.EnableImpeller" android:value="true" />\n'

content = open(MANIFEST_PATH).read()

for permission in PERMISSIONS:
    if permission not in content:
        content = re.sub(
            r"(<manifest [^>]*>)",
            rf'\1\n    <uses-permission android:name="{permission}" />',
            content,
            count=1,
        )

if "com.linusu.flutter_web_auth_2.CallbackActivity" not in content:
    content = re.sub(r"(\s*)(</application>)", rf"\1{CALLBACK_ACTIVITY}\1\2", content, count=1)

# Real requirement for on-device speech recognition (speech_to_text
# package) added 2026-08-06: Android 11+ (API 30+) restricts package
# visibility by default, so without this <queries> block the OS's own
# speech recognition service becomes invisible to the app and
# SpeechToText.initialize() silently reports unavailable. Confirmed
# against the plugin's own documented Android SDK 30+ setup
# requirement, not guessed at — this project already compiles against
# SDK 36, well above that threshold, so this genuinely applies here.
QUERIES_BLOCK = """    <queries>
        <intent>
            <action android:name="android.speech.RecognitionService" />
        </intent>
    </queries>
"""

if "android.speech.RecognitionService" not in content:
    content = re.sub(r"(\s*)(<application)", rf"\1{QUERIES_BLOCK}\1\2", content, count=1)

if "EnableImpeller" not in content:
    content = re.sub(r"(\s*)(</application>)", rf"\1{IMPELLER_FLAG}\1\2", content, count=1)

open(MANIFEST_PATH, "w").write(content)

final = open(MANIFEST_PATH).read()
for permission in PERMISSIONS:
    assert permission in final, f"missing permission after patch: {permission}"
assert "com.linusu.flutter_web_auth_2.CallbackActivity" in final, "missing CallbackActivity after patch"
assert "android.speech.RecognitionService" in final, "missing speech recognition queries block after patch"
assert "EnableImpeller" in final, "missing Impeller flag after patch"
print("All permissions, the CallbackActivity, and the Impeller flag confirmed present in manifest.")

# Real Kotlin Gradle plugin version bump - the actual root cause of a
# real jni/build.gradle failure found live on the first native build.
# Real fix, found live: this Flutter version generates settings.gradle
# as Kotlin DSL (.kts), not the Groovy (.gradle) this originally
# assumed - checking both real paths rather than hardcoding one.
KOTLIN_VERSION = "2.1.0"
SETTINGS_GRADLE_CANDIDATES = ["android/settings.gradle.kts", "android/settings.gradle"]
settings_path = next((p for p in SETTINGS_GRADLE_CANDIDATES if os.path.exists(p)), None)

if settings_path is None:
    print(f"WARNING: no settings.gradle(.kts) found at {SETTINGS_GRADLE_CANDIDATES} — nothing patched.")
else:
    settings = open(settings_path).read()
    # Handles both real syntax forms: Groovy's id "x" version "y" and
    # Kotlin DSL's id("x") version "y" - either could be what a given
    # Flutter version actually generates.
    new_settings, count = re.subn(
        r'(id\(?\s*["\']org\.jetbrains\.kotlin\.android["\']\s*\)?\s+version\s+["\'])[^"\']+(["\'])',
        rf"\g<1>{KOTLIN_VERSION}\g<2>",
        settings,
    )
    if count == 0:
        print(f"WARNING: no Kotlin plugin version line found in {settings_path} — nothing patched.")
    else:
        open(settings_path, "w").write(new_settings)
        assert KOTLIN_VERSION in open(settings_path).read()
        print(f"Kotlin Gradle plugin version bumped to {KOTLIN_VERSION} in {settings_path}.")

# Real, genuinely different issue found live on the next build after
# the jni fix worked: a transitive dependency (flutter_plugin_android_
# lifecycle) now requires compileSdk 36+, but this project compiles
# against whatever flutter.compileSdkVersion currently resolves to
# (34, per the real build error). Overriding to a hardcoded, higher
# value directly, since Flutter's own bundled default is lagging.
COMPILE_SDK_VERSION = 36
APP_BUILD_GRADLE_CANDIDATES = ["android/app/build.gradle.kts", "android/app/build.gradle"]
app_gradle_path = next((p for p in APP_BUILD_GRADLE_CANDIDATES if os.path.exists(p)), None)

if app_gradle_path is None:
    print(f"WARNING: no app/build.gradle(.kts) found at {APP_BUILD_GRADLE_CANDIDATES} — nothing patched.")
else:
    app_gradle = open(app_gradle_path).read()
    # Handles both real syntax forms: Kotlin DSL's compileSdk =
    # flutter.compileSdkVersion and Groovy's compileSdk
    # flutter.compileSdkVersion (with or without the equals sign).
    new_app_gradle, count = re.subn(
        r"(compileSdk\s*=?\s*)flutter\.compileSdkVersion",
        rf"\g<1>{COMPILE_SDK_VERSION}",
        app_gradle,
    )
    if count == 0:
        print(f"WARNING: no compileSdk = flutter.compileSdkVersion line found in {app_gradle_path} — nothing patched.")
    else:
        open(app_gradle_path, "w").write(new_app_gradle)
        assert str(COMPILE_SDK_VERSION) in open(app_gradle_path).read()
        print(f"compileSdk overridden to {COMPILE_SDK_VERSION} in {app_gradle_path}.")

# Real fix for the actual, precise cause found live: the app-level
# compileSdk override above only affects the :app module itself. Each
# third-party plugin (like file_picker) is its own, independent Gradle
# subproject with its own compileSdk setting, untouched by the app's
# own override. A real subprojects block in the root-level
# build.gradle.kts is the standard way to force every Android module
# - including plugin modules - to compile against a consistent SDK
# version, overriding whatever each individual plugin's own build
# file specifies.
ROOT_BUILD_GRADLE_CANDIDATES = ["android/build.gradle.kts", "android/build.gradle"]
root_gradle_path = next((p for p in ROOT_BUILD_GRADLE_CANDIDATES if os.path.exists(p)), None)

SUBPROJECTS_SDK_BLOCK = f"""
subprojects {{
    afterEvaluate {{
        val isAndroidModule = plugins.hasPlugin("com.android.application") || plugins.hasPlugin("com.android.library")
        if (isAndroidModule) {{
            val androidExt = extensions.findByName("android") as? BaseExtension
            androidExt?.compileSdkVersion({COMPILE_SDK_VERSION})
        }}
    }}
}}
"""
IMPORT_LINE = "import com.android.build.gradle.BaseExtension\n"

if root_gradle_path is None:
    print(f"WARNING: no root android/build.gradle(.kts) found at {ROOT_BUILD_GRADLE_CANDIDATES} — nothing patched.")
else:
    root_gradle = open(root_gradle_path).read()
    if "androidExt?.compileSdkVersion" not in root_gradle:
        # Real fix, found live via local testing: a Kotlin import must
        # sit at the very top of the file, never appended after other
        # code - prepending it separately from the appended block.
        # Real fix, found live: appending this block at the end put
        # it after the existing evaluationDependsOn(":app") block,
        # which forces early evaluation - by the time this ran,
        # afterEvaluate on those same projects threw "Cannot run
        # Project.afterEvaluate(Action) when the project is already
        # evaluated." Registering it first, right after the import,
        # ensures it runs before anything else can force evaluation.
        new_root_gradle = IMPORT_LINE + SUBPROJECTS_SDK_BLOCK + root_gradle
        open(root_gradle_path, "w").write(new_root_gradle)
        assert "androidExt?.compileSdkVersion" in open(root_gradle_path).read()
        print(f"Real subprojects compileSdk-forcing block appended to {root_gradle_path}.")
    else:
        print(f"Subprojects compileSdk-forcing block already present in {root_gradle_path} — skipping.")


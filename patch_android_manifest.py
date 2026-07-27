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
import re

MANIFEST_PATH = "android/app/src/main/AndroidManifest.xml"
SETTINGS_GRADLE_PATH = "android/settings.gradle"

PERMISSIONS = [
    "android.permission.INTERNET",
    "android.permission.RECORD_AUDIO",
    "android.permission.CAMERA",
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

open(MANIFEST_PATH, "w").write(content)

final = open(MANIFEST_PATH).read()
for permission in PERMISSIONS:
    assert permission in final, f"missing permission after patch: {permission}"
assert "com.linusu.flutter_web_auth_2.CallbackActivity" in final, "missing CallbackActivity after patch"
print("All permissions and the CallbackActivity confirmed present in manifest.")

# Real Kotlin Gradle plugin version bump - the actual root cause of a
# real jni/build.gradle failure found live on the first native build.
KOTLIN_VERSION = "2.1.0"
settings = open(SETTINGS_GRADLE_PATH).read()
new_settings, count = re.subn(
    r'(id\s+["\']org\.jetbrains\.kotlin\.android["\']\s+version\s+["\'])[^"\']+(["\'])',
    rf"\g<1>{KOTLIN_VERSION}\g<2>",
    settings,
)
if count == 0:
    print(f"WARNING: no Kotlin plugin version line found in {SETTINGS_GRADLE_PATH} — nothing patched.")
else:
    open(SETTINGS_GRADLE_PATH, "w").write(new_settings)
    assert KOTLIN_VERSION in open(SETTINGS_GRADLE_PATH).read()
    print(f"Kotlin Gradle plugin version bumped to {KOTLIN_VERSION} in {SETTINGS_GRADLE_PATH}.")


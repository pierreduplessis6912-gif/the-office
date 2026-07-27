"""Patches the freshly-generated AndroidManifest.xml with everything
this app's real, actual capabilities need - permissions the manifest
doesn't have yet, and the CallbackActivity flutter_web_auth_2 requires
to catch the theoffice:// OAuth redirect. Kept as a real, separate,
readable script rather than a growing inline python -c command.
"""
import re

MANIFEST_PATH = "android/app/src/main/AndroidManifest.xml"

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

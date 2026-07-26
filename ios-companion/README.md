# iDrivePulse Companion for iPhone

This SwiftUI app provides a dedicated, writable **Portable Files** folder inside its sandbox. It supports Files import/export, sharing, deletion with confirmation, local SHA-256 manifests, a File Provider extension, and certificate-pinned wireless exchange. The Windows app accesses only the app's Documents container through Apple's trusted House Arrest/AFC service.

## Build

1. On a Mac, install [XcodeGen](https://github.com/yonaskolb/XcodeGen).
2. Run `xcodegen generate` in this directory.
3. Open `iDrivePulseCompanion.xcodeproj` and select your Apple development team for both targets.
4. Confirm the App Groups capability contains `group.com.idrivepulse.companion` on the app and extension. A paid team may be required to provision the File Provider capability.
5. Connect the iPhone, Run, then open the app once and import files with the **+** button.

## Three file paths

- **USB Portable Files:** the app's Documents folder. This is the only location the Windows House Arrest client can open.
- **iOS Files provider:** choose **Publish in Files** on a Portable Files item. The copy appears under iDrivePulse in Files and can be edited by other document apps.
- **Secure PC exchange:** in the Windows Recovery Fabric tab, click **Start + pair**. Enter the shown HTTPS endpoint, six-digit code, and full certificate SHA-256 in the iPhone app. The code expires after five minutes. Transfers are authenticated, TLS-encrypted, and verified by SHA-256 after download.

The Files provider and USB Documents folder are separate sandbox locations by design. Publishing creates a copy so an external editor cannot silently mutate the recovery original. Wireless access is off by default and the companion refuses unpinned or plain-HTTP servers.

The bundle identifier must remain `com.idrivepulse.companion` so the Windows app can find it. Development builds are subject to Apple's signing and entitlement rules. This companion does not jailbreak, root, bypass Data Protection, or modify iOS.

import Contacts
import Foundation

actor ContactBackupService {
    func exportVCard() async throws -> (url: URL, count: Int) {
        let store = CNContactStore()
        let granted = try await store.requestAccess(for: .contacts)
        guard granted else {
            throw PocketDockError.server("Contacts access was not granted.")
        }
        let keys = [
            CNContactVCardSerialization.descriptorForRequiredKeys()
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.unifyResults = true
        var contacts: [CNContact] = []
        try store.enumerateContacts(with: request) { contact, _ in
            contacts.append(contact)
        }
        let data = try CNContactVCardSerialization.data(with: contacts)
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
            "PocketDock Contacts \(formatter.string(from: Date())).vcf"
        )
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return (url, contacts.count)
    }
}

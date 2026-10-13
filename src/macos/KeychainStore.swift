import Foundation
import Security

// Where a remembered API key is kept. Tests use an in-memory store so they never touch the user's Keychain.
protocol KeyStoring {
    func load() -> String?
    @discardableResult func save(_ key: String) -> Bool
    func delete()
}

// A secret in the login Keychain. The OpenAI key is only stored when the user ticks "記住金鑰"
// (otherwise it stays in memory); the audience-sharing relay settings are always stored.
struct KeychainStore: KeyStoring {
    private let service = "local.keynote-live-translator"
    private let account: String
    private let label: String

    init(account: String = "openai-api-key", label: String = "Keynote Live Translator OpenAI API key") {
        self.account = account
        self.label = label
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    @discardableResult
    func save(_ key: String) -> Bool {
        delete()
        var query = baseQuery
        query[kSecValueData as String] = Data(key.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        query[kSecAttrLabel as String] = label
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

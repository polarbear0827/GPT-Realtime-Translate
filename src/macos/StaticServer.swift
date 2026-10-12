import Foundation
import Network

// Serves the bundled web UI over http://127.0.0.1 (a secure context, so getUserMedia works).
// It only serves static files: the API key and OpenAI calls go through the WKWebView message
// bridge instead, so other local programs that reach this port can't use the key.
final class StaticServer {
    private let root: URL
    private let queue = DispatchQueue(label: "local.keynote-live-translator.static-server")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    static let contentSecurityPolicy =
        "default-src 'self'; connect-src 'self' https://api.openai.com wss://api.openai.com; media-src 'self' blob:; " +
        "img-src 'self' data:; style-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'; " +
        "base-uri 'self'; form-action 'none'; frame-ancestors 'none'"

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    // Tries the preferred port first (so localStorage settings keep the same origin across launches)
    // and falls back to any free port. The UI is always loaded from our own listener, so another
    // program holding the preferred port can never be mistaken for the app.
    func start(preferredPort: UInt16, completion: @escaping (Result<UInt16, Error>) -> Void) {
        listen(on: preferredPort) { [weak self] result in
            switch result {
            case .success:
                completion(result)
            case .failure where preferredPort != 0:
                self?.listen(on: 0, completion: completion)
            case .failure:
                completion(result)
            }
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func listen(on port: UInt16, completion: @escaping (Result<UInt16, Error>) -> Void) {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port) ?? .any)
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
        let listener: NWListener
        do {
            listener = try NWListener(using: parameters)
        } catch {
            completion(.failure(error))
            return
        }
        var finished = false
        let finish: (Result<UInt16, Error>) -> Void = { result in
            guard !finished else { return }
            finished = true
            DispatchQueue.main.async { completion(result) }
        }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            switch state {
            case .ready:
                let actual = listener?.port?.rawValue ?? 0
                self?.port = actual
                finish(.success(actual))
            case .failed(let error):
                listener?.cancel()
                finish(.failure(error))
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        self.listener = listener
        listener.start(queue: queue)
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(connection, head: buffer.subdata(in: buffer.startIndex..<end.lowerBound))
            } else if buffer.count > 16_384 || isComplete || error != nil {
                connection.cancel()
            } else {
                self.receive(connection, buffer: buffer)
            }
        }
    }

    private func respond(_ connection: NWConnection, head: Data) {
        let lines = String(decoding: head, as: UTF8.self).components(separatedBy: "\r\n")
        let parts = lines.first?.split(separator: " ", maxSplits: 2).map(String.init) ?? []
        guard parts.count >= 2 else {
            send(connection, status: 400, body: Data("Bad request".utf8), contentType: "text/plain")
            return
        }
        let method = parts[0]
        var host = ""
        for line in lines.dropFirst() {
            if let colon = line.firstIndex(of: ":"), line[..<colon].trimmingCharacters(in: .whitespaces).lowercased() == "host" {
                host = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces).lowercased()
            }
        }
        // Rejects DNS-rebinding requests that reach the port under another host name.
        guard host == "127.0.0.1:\(port)" || host == "localhost:\(port)" else {
            send(connection, status: 403, body: Data("Forbidden".utf8), contentType: "text/plain")
            return
        }
        guard method == "GET" || method == "HEAD" else {
            send(connection, status: 405, body: Data("Method not allowed".utf8), contentType: "text/plain")
            return
        }
        let target = parts[1].split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
        guard let decoded = target.removingPercentEncoding else {
            send(connection, status: 400, body: Data("Bad request".utf8), contentType: "text/plain")
            return
        }
        let relative = decoded == "/" ? "index.html" : String(decoded.drop(while: { $0 == "/" }))
        let fileURL = root.appendingPathComponent(relative).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard fileURL.path.hasPrefix(root.path + "/"),
              FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory),
              !isDirectory.boolValue,
              let body = try? Data(contentsOf: fileURL)
        else {
            send(connection, status: 404, body: Data("Not found".utf8), contentType: "text/plain")
            return
        }
        send(connection, status: 200, body: body, contentType: Self.contentType(for: fileURL.pathExtension), includeBody: method == "GET")
    }

    private func send(_ connection: NWConnection, status: Int, body: Data, contentType: String, includeBody: Bool = true) {
        let reasons = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed"]
        let header = [
            "HTTP/1.1 \(status) \(reasons[status] ?? "Error")",
            "Content-Type: \(contentType)",
            "Content-Length: \(body.count)",
            "Cache-Control: no-cache",
            "Content-Security-Policy: \(Self.contentSecurityPolicy)",
            "X-Content-Type-Options: nosniff",
            "X-Frame-Options: DENY",
            "Referrer-Policy: no-referrer",
            "Connection: close",
            "",
            "",
        ].joined(separator: "\r\n")
        var response = Data(header.utf8)
        if includeBody { response.append(body) }
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }

    static func contentType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html": return "text/html;charset=utf-8"
        case "css": return "text/css;charset=utf-8"
        case "js": return "text/javascript;charset=utf-8"
        case "json": return "application/json;charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        default: return "application/octet-stream"
        }
    }
}

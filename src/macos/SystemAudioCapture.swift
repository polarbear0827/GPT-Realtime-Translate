import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

// Captures what the Mac is playing (YouTube, a meeting app, …) digitally with a Core Audio process tap,
// so nothing has to come out of the speakers into the microphone. Needs macOS 14.2+ and the user's
// "System Audio Recording" permission (NSAudioCaptureUsageDescription); without it the tap delivers silence.
//
// Output matches the web UI's microphone pipeline: 24 kHz mono PCM16 in 50 ms chunks plus RMS/peak.

struct SystemAudioError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Converts any Core Audio buffer format to 24 kHz mono PCM16 and cuts it into fixed-size chunks.
final class PCMDownsampler {
    static let chunkSamples = 1200

    let inputFormat: AVAudioFormat
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
    private let converter: AVAudioConverter
    private var pending: [Int16] = []

    init?(inputFormat: AVAudioFormat) {
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else { return nil }
        converter.downmix = true
        self.inputFormat = inputFormat
        self.converter = converter
    }

    /// Feeds one input buffer; returns the complete 50 ms chunks (PCM16 bytes, RMS, peak) now available.
    func process(_ input: AVAudioPCMBuffer) -> [(Data, Float, Float)] {
        let capacity = AVAudioFrameCount(Double(input.frameLength) * outputFormat.sampleRate / inputFormat.sampleRate) + 64
        guard input.frameLength > 0, let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return [] }
        var provided = false
        var error: NSError?
        // The converter keeps its resampling state between calls, so chunk boundaries stay continuous.
        converter.convert(to: output, error: &error) { _, status in
            if provided {
                status.pointee = .noDataNow
                return nil
            }
            provided = true
            status.pointee = .haveData
            return input
        }
        guard error == nil, let samples = output.int16ChannelData?[0] else { return [] }
        pending.append(contentsOf: UnsafeBufferPointer(start: samples, count: Int(output.frameLength)))

        var chunks: [(Data, Float, Float)] = []
        while pending.count >= Self.chunkSamples {
            let chunk = Array(pending[0..<Self.chunkSamples])
            pending.removeFirst(Self.chunkSamples)
            var sumSquares: Float = 0
            var peak: Float = 0
            for sample in chunk {
                let value = Float(sample) / 32768
                sumSquares += value * value
                peak = max(peak, abs(value))
            }
            let data = chunk.withUnsafeBufferPointer { Data(buffer: $0) }
            chunks.append((data, (sumSquares / Float(Self.chunkSamples)).squareRoot(), peak))
        }
        return chunks
    }
}

// start/stop and device-change restarts run on the main thread; only the IO callback runs on `queue`,
// and it is torn down (AudioDeviceStop + DestroyIOProcID) before any state it reads is released.
@available(macOS 14.2, *)
final class SystemAudioCapture {
    /// Called on a background queue with 24 kHz mono PCM16 chunks.
    var onChunk: ((Data, Float, Float) -> Void)?
    /// Called on the main thread when capture stops unexpectedly.
    var onFailure: ((String) -> Void)?

    private let queue = DispatchQueue(label: "local.keynote-live-translator.system-audio", qos: .userInteractive)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var downsampler: PCMDownsampler?
    private var outputListener: AudioObjectPropertyListenerBlock?
    private var muteSource = false

    deinit {
        stop()
    }

    func start(muteSource: Bool) throws {
        stop()
        self.muteSource = muteSource
        do {
            try createTapAndDevice()
            listenForOutputDeviceChanges()
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        if let outputListener {
            var address = Self.address(kAudioHardwarePropertyDefaultSystemOutputDevice)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, outputListener)
            self.outputListener = nil
        }
        destroyTapAndDevice()
    }

    private func createTapAndDevice() throws {
        // Everything except this app, so audio we might play ourselves is never translated again.
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: Self.ownProcessObjects())
        description.uuid = UUID()
        description.name = "Keynote Live Translator"
        description.isPrivate = true
        description.muteBehavior = muteSource ? .mutedWhenTapped : .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        try Self.check(AudioHardwareCreateProcessTap(description, &tap), "無法建立系統音訊擷取")
        tapID = tap

        var streamDescription = try Self.read(tap, kAudioTapPropertyFormat, AudioStreamBasicDescription())
        guard let format = AVAudioFormat(streamDescription: &streamDescription), let downsampler = PCMDownsampler(inputFormat: format) else {
            throw SystemAudioError(message: "系統音訊格式不支援。")
        }
        self.downsampler = downsampler

        // The aggregate device uses the current output device as its clock and contains the tap as input.
        let outputDevice = try Self.read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(kAudioObjectUnknown))
        let outputUID = try Self.readString(outputDevice, kAudioDevicePropertyDeviceUID)
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Keynote Live Translator Capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        var device = AudioObjectID(kAudioObjectUnknown)
        try Self.check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "無法建立系統音訊裝置")
        aggregateID = device

        try Self.check(AudioDeviceCreateIOProcIDWithBlock(&procID, device, queue) { [weak self] _, inputData, _, _, _ in
            self?.process(inputData)
        }, "無法讀取系統音訊")
        try Self.check(AudioDeviceStart(device, procID), "無法開始擷取系統音訊")
    }

    private func destroyTapAndDevice() {
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
        }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
        downsampler = nil
    }

    private func process(_ bufferList: UnsafePointer<AudioBufferList>) {
        guard let downsampler,
              let buffer = AVAudioPCMBuffer(pcmFormat: downsampler.inputFormat, bufferListNoCopy: bufferList, deallocator: nil)
        else { return }
        for (data, rms, peak) in downsampler.process(buffer) {
            onChunk?(data, rms, peak)
        }
    }

    // Plugging in headphones changes the output device the aggregate is clocked from: rebuild it.
    private func listenForOutputDeviceChanges() {
        var address = Self.address(kAudioHardwarePropertyDefaultSystemOutputDevice)
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            self.destroyTapAndDevice()
            do {
                try self.createTapAndDevice()
            } catch {
                self.onFailure?((error as? LocalizedError)?.errorDescription ?? "系統音訊擷取中斷。")
            }
        }
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listener) == noErr {
            outputListener = listener
        }
    }

    // ---- Core Audio helpers ----

    private static func ownProcessObjects() -> [AudioObjectID] {
        var address = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var pid = getpid()
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object
        )
        return status == noErr && object != kAudioObjectUnknown ? [object] : []
    }

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private static func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) throws -> T {
        var address = address(selector)
        var value = initial
        var size = UInt32(MemoryLayout<T>.size)
        let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
        try check(status, "無法讀取音訊裝置資訊")
        return value
    }

    private static func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
        var address = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
        try check(status, "無法讀取輸出裝置")
        guard let string = value?.takeRetainedValue() else { throw SystemAudioError(message: "找不到音訊輸出裝置。") }
        return string as String
    }

    private static func check(_ status: OSStatus, _ message: String) throws {
        guard status == noErr else { throw SystemAudioError(message: "\(message)（錯誤碼 \(status)）。") }
    }
}

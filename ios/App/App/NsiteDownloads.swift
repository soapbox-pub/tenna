import UIKit
import WebKit

/**
 Lets a site save a file it offers.

 The iOS half of `NsiteDownloads.java`. A download is a navigation that turned
 out not to be a page, and a `WKWebView` with nobody to hand one to simply
 drops it — a site whose "Export" button does nothing when it is pressed.

 The file is written to a directory of its own under the temporary directory
 and then offered to the user through the system's export picker, which is
 the save-as dialog Android opens. Nothing lands anywhere the user did not
 choose, and the temporary copy is removed once the picker is done with it.
 */
@MainActor
final class NsiteDownloads: NSObject, WKDownloadDelegate, UIDocumentPickerDelegate {

    /// Where a picker goes. Nil once the site's window is gone.
    private let presenter: () -> UIViewController?

    private var running: Set<WKDownload> = []
    private var files: [WKDownload: URL] = [:]
    private var pickers: [UIDocumentPickerViewController: URL] = [:]

    init(presenter: @escaping () -> UIViewController?) {
        self.presenter = presenter
        super.init()
    }

    func adopt(_ download: WKDownload) {
        download.delegate = self
        running.insert(download)
    }

    /// Abandon whatever is still in flight. A picker already up is left to
    /// finish: the file is on disk and the user is looking at it.
    func tearDown() {
        for download in running {
            download.cancel { _ in }
            if let file = files[download] { Self.discard(file) }
        }
        running.removeAll()
        files.removeAll()
    }

    // MARK: - WKDownloadDelegate

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        // The name is the site's to suggest and not to aim: whatever it says,
        // the file lands in a directory made for it and nowhere else.
        var name = (suggestedFilename as NSString).lastPathComponent
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name == "." || name == ".." { name = "download" }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("nsite-downloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)

        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true)
        } catch {
            NSLog("[Nsite] could not make room for a download: \(error.localizedDescription)")
            running.remove(download)
            completionHandler(nil)
            return
        }

        let file = directory.appendingPathComponent(name)
        files[download] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        running.remove(download)
        guard let file = files.removeValue(forKey: download) else { return }

        guard let presenter = presenter() else {
            Self.discard(file)
            return
        }

        let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
        picker.delegate = self
        pickers[picker] = file
        presenter.present(picker, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("[Nsite] download failed: \(error.localizedDescription)")
        running.remove(download)
        if let file = files.removeValue(forKey: download) { Self.discard(file) }
    }

    // MARK: - UIDocumentPickerDelegate

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(controller)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(controller)
    }

    private func finish(_ picker: UIDocumentPickerViewController) {
        // Exported as a copy, so what is left behind is only ever ours.
        if let file = pickers.removeValue(forKey: picker) { Self.discard(file) }
    }

    private static func discard(_ file: URL) {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
}

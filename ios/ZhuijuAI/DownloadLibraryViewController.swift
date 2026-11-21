import AVKit
import UIKit

extension Notification.Name {
    /// 下载队列状态变了（进度 / 终态 / 排队 / 删除）。
    ///
    /// `MediaDownloader.eventSink` 已经归 `WebViewController` 独占（它要把同一批事件转给网页），
    /// 原生片库不再抢这个静态回调：由 `WebViewController` 在转发的同一个时机广播这条通知，
    /// 原生界面只订阅，不覆盖任何人的回调。
    static let downloadLibraryDidChange = Notification.Name("kj-ios-download-library-change")
}

/// 一条下载记录在界面上的样子：只读，全部来自 `MediaDownloader.snapshotForPage()`。
///
/// 快照不带封面和总集数（`cover` / `showTotal` 只在事件里出现），所以这里不编造：
/// 封面用占位图，集数只按「真的下完了几集」算。
struct DownloadLibraryItem {
    let id: String
    let showId: String
    let epKey: String
    let epLabel: String
    let title: String
    let name: String
    let status: String
    let reason: String
    let received: Int64
    let total: Int64
    let size: Int64
    let path: String
    /// 这部剧封面在本机的相对路径（快照里的 `coverPath`），空串 = 还没有本地封面。
    let coverPath: String

    init?(_ raw: [String: Any]) {
        guard let status = raw["status"] as? String, !status.isEmpty else { return nil }
        self.status = status
        id = raw["id"] as? String ?? ""
        showId = raw["showId"] as? String ?? ""
        epKey = raw["epKey"] as? String ?? ""
        epLabel = raw["epLabel"] as? String ?? ""
        title = raw["title"] as? String ?? ""
        name = raw["name"] as? String ?? ""
        reason = raw["reason"] as? String ?? ""
        received = (raw["received"] as? NSNumber)?.int64Value ?? 0
        total = (raw["total"] as? NSNumber)?.int64Value ?? 0
        size = (raw["size"] as? NSNumber)?.int64Value ?? 0
        path = raw["path"] as? String ?? ""
        coverPath = raw["coverPath"] as? String ?? ""
    }

    /// 本机封面图：只认下载器落盘的 `DownloadCovers` 直接子项，读不出来就当没有。
    var coverImage: UIImage? {
        guard !coverPath.isEmpty,
              let url = MediaDownloader.coverURL(forStoredPath: coverPath) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }

    /// 归组用的键：剧号优先，没有剧号时退回剧名，再没有就用任务 id（一部剧一条，不会混在一起）。
    var showKey: String {
        if !showId.isEmpty { return showId }
        if !title.isEmpty { return "title:" + title }
        return "id:" + id
    }

    var showTitle: String {
        if !title.isEmpty { return title }
        if !name.isEmpty { return name }
        return "未命名剧集"
    }

    var episodeTitle: String {
        if !epLabel.isEmpty { return epLabel }
        if !epKey.isEmpty { return "第" + epKey + "集" }
        return name.isEmpty ? "未命名文件" : name
    }

    var isDone: Bool { status == "done" }

    /// 磁盘上这一集的扩展名（还没落盘时是空串），用来判断 App 内能不能真的播。
    var storedExtension: String { (path as NSString).pathExtension.lowercased() }

    /// 还在队列里（正在传 / 等空位 / 暂停）：这些排在已完成的前面。
    var isActive: Bool { status == "running" || status == "queued" || status == "paused" }

    /// 进度：总长度未知时返回 nil，界面不许编百分比。
    var fraction: Double? {
        guard total > 0 else { return nil }
        return min(1, max(0, Double(received) / Double(total)))
    }

    var statusText: String {
        switch status {
        case "running":
            if let progress = fraction { return "下载中 " + DownloadLibraryFormat.percent(progress) }
            return "下载中 · 已收 " + DownloadLibraryFormat.bytes(received)
        case "queued": return "排队中"
        case "paused":
            if let progress = fraction { return "已暂停 " + DownloadLibraryFormat.percent(progress) }
            return "已暂停"
        case "done":
            let onDisk = size > 0 ? size : received
            return onDisk > 0 ? DownloadLibraryFormat.bytes(onDisk) : "已下载"
        case "failed": return reason.isEmpty ? "下载失败" : "下载失败 · " + reason
        case "cancelled": return "已取消"
        default: return status
        }
    }
}

/// 一部剧在片库里的一行：聚合它自己的集。
struct DownloadLibraryShow {
    let key: String
    let title: String
    let items: [DownloadLibraryItem]

    /// 一级、二级都只读这一张图：同一部剧的封面只有一份，不按集分别存。
    var coverImage: UIImage? {
        items.compactMap { $0.coverImage }.first
    }

    var coverPath: String {
        items.first { !$0.coverPath.isEmpty }?.coverPath ?? ""
    }

    var doneCount: Int { items.filter { $0.isDone }.count }
    var activeCount: Int { items.filter { $0.isActive }.count }
    var failedCount: Int { items.filter { $0.status == "failed" }.count }

    /// 这一部剧已完成集在记录里的字节数（真实占用按磁盘另算，见 footer）。
    var doneBytes: Int64 {
        items.filter { $0.isDone }.reduce(Int64(0)) { $0 + ($1.size > 0 ? $1.size : $1.received) }
    }

    var subtitle: String {
        var text = "已下载 " + String(doneCount) + " 集"
        if doneBytes > 0 { text += " · " + DownloadLibraryFormat.bytes(doneBytes) }
        if activeCount > 0 { text += " · " + String(activeCount) + " 集未完成" }
        return text
    }

    /// 有任务的剧排前面，其余按剧名。
    static func group(_ items: [DownloadLibraryItem]) -> [DownloadLibraryShow] {
        var order: [String] = []
        var buckets: [String: [DownloadLibraryItem]] = [:]
        for item in items {
            if buckets[item.showKey] == nil {
                buckets[item.showKey] = []
                order.append(item.showKey)
            }
            buckets[item.showKey]?.append(item)
        }
        var shows: [DownloadLibraryShow] = []
        for key in order {
            guard let list = buckets[key], let first = list.first else { continue }
            shows.append(DownloadLibraryShow(key: key, title: first.showTitle, items: sortedEpisodes(list)))
        }
        shows.sort { left, right in
            if (left.activeCount > 0) != (right.activeCount > 0) { return left.activeCount > 0 }
            return left.title.localizedStandardCompare(right.title) == .orderedAscending
        }
        return shows
    }

    /// 集内顺序：正在传 / 排队的置顶，然后是已完成，失败和取消垫底；同组按集号。
    static func sortedEpisodes(_ items: [DownloadLibraryItem]) -> [DownloadLibraryItem] {
        func rank(_ item: DownloadLibraryItem) -> Int {
            switch item.status {
            case "running": return 0
            case "queued": return 1
            case "paused": return 2
            case "done": return 3
            case "failed": return 4
            default: return 5
            }
        }
        return items.sorted { left, right in
            let leftRank = rank(left)
            let rightRank = rank(right)
            if leftRank != rightRank { return leftRank < rightRank }
            let leftNumber = Int(left.epKey) ?? Int.max
            let rightNumber = Int(right.epKey) ?? Int.max
            if leftNumber != rightNumber { return leftNumber < rightNumber }
            return left.episodeTitle.localizedStandardCompare(right.episodeTitle) == .orderedAscending
        }
    }
}

/// 格式化只写一处，列表和底部占用用的是同一套单位。
enum DownloadLibraryFormat {
    static func bytes(_ value: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowedUnits = [.useMB, .useGB]
        return formatter.string(fromByteCount: max(0, value))
    }

    static func percent(_ value: Double) -> String {
        return String(Int((value * 100).rounded())) + "%"
    }
}

/// 删除前的确认：整剧和单集都要用户再点一次，滑一下就删掉太容易误删。
private func confirmDeletion(
    on controller: UIViewController,
    title: String,
    message: String,
    action: @escaping () -> Void
) {
    let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "取消", style: .cancel))
    alert.addAction(UIAlertAction(title: "删除", style: .destructive) { _ in action() })
    controller.present(alert, animated: true)
}

// MARK: - 一级：按剧分组

/// 原生「我的下载」入口：不加载网页也能用，飞行模式下照样按剧看全库。
///
/// 数据只有一份：`MediaDownloader` 的记录快照。这里不落任何自己的持久化，
/// 也不改下载文件命名 / 目录 / 后台引擎。
final class DownloadLibraryViewController: UITableViewController {
    /// 播放交给 `WebViewController`（它已经管着离线播放器的生命周期，删除时要先停播）。
    /// 交过去的是整部剧「已完成且本地存在」的集和起点，选集 / 上一集 / 下一集都在里面走。
    var onPlay: ((OfflinePlaylist, Int) -> Void)?
    /// 删除文件前先停掉正在播的同一集。
    var onStopPlayback: ((String) -> Void)?

    private let downloader: MediaDownloader
    private var shows: [DownloadLibraryShow] = []
    private var refreshTimer: Timer?
    private var lastSignature = ""
    private let usageLabel = UILabel()
    private var notificationToken: NSObjectProtocol?
    /// 整剧删除是一次循环：循环里的每一次删除都会广播通知，这里先不跟着重画，
    /// 全部处理完再一次刷新（部分失败时还要弹提示）。
    private var isBatchDeleting = false

    init(downloader: MediaDownloader = .shared) {
        self.downloader = downloader
        super.init(style: .insetGrouped)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        refreshTimer?.invalidate()
        if let token = notificationToken { NotificationCenter.default.removeObserver(token) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "我的下载"
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = .black
        tableView.backgroundColor = .black
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "show")
        tableView.rowHeight = 64
        tableView.tableFooterView = makeUsageFooter()
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "关闭",
            style: .plain,
            target: self,
            action: #selector(close)
        )
        notificationToken = NotificationCenter.default.addObserver(
            forName: .downloadLibraryDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.reload()
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        reload(force: true)
        downloader.restore { [weak self] in
            DispatchQueue.main.async { self?.reload() }
        }
        /* 老记录没有本地封面：联网时按记录里带的封面地址补一次并落盘。
           断网失败不算「这部剧没有封面」，下次打开片库还会再试。 */
        downloader.backfillCovers { [weak self] in
            self?.reload(force: true)
        }
        startRefreshTimer()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    @objc private func close() {
        dismiss(animated: true)
    }

    // MARK: - 数据

    /// 只有「真的变了」才重画：每秒刷新进度时不打断用户正在做的左滑。
    private func reload(force: Bool = false) {
        guard !isBatchDeleting else { return }
        let items = downloader.snapshotForPage().compactMap { DownloadLibraryItem($0) }
        let next = DownloadLibraryShow.group(items)
        let signature = Self.signature(items)
        guard force || signature != lastSignature else { return }
        lastSignature = signature
        shows = next
        updateUsageFooter()
        tableView.reloadData()
        tableView.backgroundView = shows.isEmpty ? makeEmptyView() : nil
    }

    private func startRefreshTimer() {
        refreshTimer?.invalidate()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            self?.reload()
        }
        /* 加进 common 模式：手指按着列表时进度也继续走，不会被滑动吃掉。 */
        RunLoop.main.add(timer, forMode: .common)
        refreshTimer = timer
    }

    private static func signature(_ items: [DownloadLibraryItem]) -> String {
        return items.map { item in
            /* 进度只按 1% 取整进签名：百分比没动就不重画。封面到位也算变化。 */
            let bucket = item.total > 0 ? Int((Double(item.received) / Double(item.total)) * 100) : -1
            return item.id + "|" + item.status + "|" + String(bucket) + "|" + item.path + "|" + item.coverPath
        }.joined(separator: ";")
    }

    private func makeEmptyView() -> UIView {
        let label = UILabel()
        label.text = "还没有下载完成的剧集\n断网也能在这里播放和分享"
        label.textColor = UIColor.white.withAlphaComponent(0.6)
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.numberOfLines = 0
        label.textAlignment = .center
        let container = UIView()
        container.addSubview(label)
        label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: -60),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -24),
        ])
        return container
    }

    // MARK: - 底部占用

    private func makeUsageFooter() -> UIView {
        let footer = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 48))
        usageLabel.font = .preferredFont(forTextStyle: .footnote)
        usageLabel.textColor = UIColor.white.withAlphaComponent(0.6)
        usageLabel.textAlignment = .center
        usageLabel.numberOfLines = 0
        usageLabel.translatesAutoresizingMaskIntoConstraints = false
        footer.addSubview(usageLabel)
        NSLayoutConstraint.activate([
            usageLabel.leadingAnchor.constraint(equalTo: footer.leadingAnchor, constant: 16),
            usageLabel.trailingAnchor.constraint(equalTo: footer.trailingAnchor, constant: -16),
            usageLabel.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
        ])
        usageLabel.text = Self.usageText()
        return footer
    }

    private func updateUsageFooter() {
        usageLabel.text = Self.usageText()
    }

    /// 真实占用按磁盘算（记录里的 size 只是字段）；剩余空间问系统。
    static func usageText() -> String {
        let used = downloadedBytesOnDisk()
        var text = "本 App 下载占用 " + DownloadLibraryFormat.bytes(used)
        if let free = freeDiskBytes() {
            text += " · 剩余空间 " + DownloadLibraryFormat.bytes(free)
        }
        return text
    }

    static func downloadedBytesOnDisk() -> Int64 {
        guard let directory = MediaDownloader.directory() else { return 0 }
        let manager = FileManager.default
        guard let files = try? manager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }
        var total: Int64 = 0
        for file in files {
            let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values?.isRegularFile == true, let size = values?.fileSize else { continue }
            total += Int64(size)
        }
        return total
    }

    static func freeDiskBytes() -> Int64? {
        guard let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let values = try? base.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
              let free = values.volumeAvailableCapacityForImportantUsage else { return nil }
        return free
    }

    // MARK: - 表格

    override func numberOfSections(in tableView: UITableView) -> Int { 1 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        shows.count
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "show", for: indexPath)
        let show = shows[indexPath.row]
        var content = cell.defaultContentConfiguration()
        content.text = show.title
        content.secondaryText = show.subtitle
        content.secondaryTextProperties.color = .secondaryLabel
        /* 有本地封面就用本地封面（飞行模式也在）；没有就画带剧名的占位，不留白。 */
        content.image = show.coverImage ?? Self.placeholderCover(for: show.title)
        content.imageProperties.maximumSize = CGSize(width: 44, height: 60)
        content.imageProperties.cornerRadius = 6
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        cell.backgroundColor = UIColor(white: 0.11, alpha: 1)
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let show = shows[indexPath.row]
        let controller = DownloadEpisodesViewController(show: show, downloader: downloader)
        controller.onPlay = onPlay
        controller.onStopPlayback = onStopPlayback
        navigationController?.pushViewController(controller, animated: true)
    }

    override func tableView(
        _ tableView: UITableView,
        trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath
    ) -> UISwipeActionsConfiguration? {
        let show = shows[indexPath.row]
        let delete = UIContextualAction(style: .destructive, title: "删除") { [weak self] _, _, done in
            guard let self = self else {
                done(false)
                return
            }
            confirmDeletion(
                on: self,
                title: "删除《" + show.title + "》",
                message: "会删掉这部剧已下载的 " + String(show.doneCount) + " 集本地文件，不能恢复。"
            ) {
                self.deleteShow(show)
            }
            done(true)
        }
        return UISwipeActionsConfiguration(actions: [delete])
    }

    // MARK: - 删除

    /// 整剧删除按集处理：每一集都是「停播 → 删文件 → 删记录」，部分失败时保留失败的那几集，
    /// 不把整部剧当成一次原子操作假装全删了。
    private func deleteShow(_ show: DownloadLibraryShow) {
        isBatchDeleting = true
        var failed = 0
        var removed = 0
        for item in show.items {
            if deleteItem(item) { removed += 1 } else { failed += 1 }
        }
        isBatchDeleting = false
        reload(force: true)
        if failed > 0 {
            let alert = UIAlertController(
                title: "有 " + String(failed) + " 集没删掉",
                message: "已删除 " + String(removed) + " 集。删不掉的那几集还留在列表里，请稍后再试。",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "好", style: .default))
            present(alert, animated: true)
        }
    }

    /// 删一集：先停掉同一集正在播的播放器，再真删文件，最后才删记录。
    /// 文件删不掉就返回 false，记录原样保留。
    @discardableResult
    private func deleteItem(_ item: DownloadLibraryItem) -> Bool {
        /* 确认框开着的那几秒里这一集可能刚好下完：最新记录和确认前的旧快照两份路径都算，
           任一份上的文件还在就删掉；只要有一个删不掉就保留记录，不让文件变孤儿。 */
        let paths = downloadLibraryDeletionPaths(for: item, downloader: downloader)
        for path in paths {
            onStopPlayback?(path)
        }
        for path in paths where !downloader.removeDownloadedFile(at: path) {
            return false
        }
        downloader.deleteEpisode(
            id: item.id.isEmpty ? nil : item.id,
            showId: item.showId,
            epKey: item.epKey
        )
        return true
    }

    /// 没有本地封面时的占位：灰砖上写剧名（最多两行），不拿白块充数。
    static func placeholderCover(for title: String) -> UIImage {
        let size = CGSize(width: 44, height: 60)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in
            UIColor(white: 0.22, alpha: 1).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 6).fill()
            let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = (name.isEmpty ? "未命名" : String(name.prefix(6))) as NSString
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            paragraph.lineBreakMode = .byTruncatingTail
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: UIColor.white.withAlphaComponent(0.85),
                .paragraphStyle: paragraph,
            ]
            let bounds = CGRect(x: 3, y: 6, width: size.width - 6, height: size.height - 12)
            text.draw(in: bounds, withAttributes: attributes)
        }
    }
}

// MARK: - 二级：一集的列表

/// 删除要动到的文件路径：最新记录和界面快照各取一份，去空去重。
/// 两份都要算，因为确认框开着的那几秒里这一集可能刚好下完、换了文件名，
/// 只删一份就会把另一份文件留成孤儿。
fileprivate func downloadLibraryDeletionPaths(
    for item: DownloadLibraryItem,
    downloader: MediaDownloader
) -> [String] {
    let live = downloader.currentStoredPath(
        id: item.id.isEmpty ? nil : item.id,
        showId: item.showId,
        epKey: item.epKey
    )
    var paths: [String] = []
    for candidate in [live, item.path] {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty && !paths.contains(trimmed) {
            paths.append(trimmed)
        }
    }
    return paths
}

/// 一部剧的集列表：点已完成的集离线播放，长按准备并分享那一个真实文件，左滑删单集。
final class DownloadEpisodesViewController: UITableViewController {
    /// 和一级一样：交过去的是整部剧的播放单和起点。
    var onPlay: ((OfflinePlaylist, Int) -> Void)?
    var onStopPlayback: ((String) -> Void)?

    private let downloader: MediaDownloader
    private var show: DownloadLibraryShow
    private var items: [DownloadLibraryItem] = []
    private var refreshTimer: Timer?
    private var lastSignature = ""
    private var notificationToken: NSObjectProtocol?

    init(show: DownloadLibraryShow, downloader: MediaDownloader = .shared) {
        self.show = show
        self.downloader = downloader
        items = show.items
        super.init(style: .insetGrouped)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        refreshTimer?.invalidate()
        if let token = notificationToken { NotificationCenter.default.removeObserver(token) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = show.title
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = .black
        tableView.backgroundColor = .black
        tableView.register(DownloadEpisodeCell.self, forCellReuseIdentifier: "episode")
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 72
        notificationToken = NotificationCenter.default.addObserver(
            forName: .downloadLibraryDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.reload()
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        reload(force: true)
        refreshTimer?.invalidate()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            self?.reload()
        }
        /* common 模式：滑动列表 / 左滑时不暂停进度刷新。 */
        RunLoop.main.add(timer, forMode: .common)
        refreshTimer = timer
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    // MARK: - 数据

    private func reload(force: Bool = false) {
        /* 从整份快照里筛出这部剧：删除、状态变化都可能发生在别的界面。 */
        let all = downloader.snapshotForPage().compactMap { DownloadLibraryItem($0) }
        let mine = all.filter { $0.showKey == show.key }
        let signature = mine.map { item in
            let bucket = item.total > 0 ? Int((Double(item.received) / Double(item.total)) * 100) : -1
            return item.id + "|" + item.status + "|" + String(bucket) + "|" + item.path
        }.joined(separator: ";")
        guard force || signature != lastSignature else { return }
        lastSignature = signature
        items = DownloadLibraryShow.sortedEpisodes(mine)
        if let first = mine.first {
            show = DownloadLibraryShow(key: show.key, title: first.showTitle, items: mine)
        }
        tableView.reloadData()
    }

    // MARK: - 表格

    override func numberOfSections(in tableView: UITableView) -> Int { 1 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        items.count
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        show.subtitle
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "episode", for: indexPath)
        guard let episode = cell as? DownloadEpisodeCell else { return cell }
        let item = items[indexPath.row]
        /* 二级每一集都只读这一部剧的同一张本地封面；没有就画带剧名的占位。 */
        episode.configure(item, cover: show.coverImage ?? DownloadLibraryViewController.placeholderCover(for: show.title))
        return episode
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let item = items[indexPath.row]
        guard item.isDone else { return }
        play(item, at: indexPath)
    }

    /// 长按：已完成的集给出「播放」和「分享本地文件」两个动作。
    /// 分享的不是远端地址、不是清单、不是目录，就是磁盘上这一个文件。
    override func tableView(
        _ tableView: UITableView,
        contextMenuConfigurationForRowAt indexPath: IndexPath,
        point: CGPoint
    ) -> UIContextMenuConfiguration? {
        let item = items[indexPath.row]
        guard item.isDone else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            guard let self = self else { return nil }
            /* App 内播不了的容器（.ts / .mkv）长按第一项直接走「用其他应用打开」，不把用户带去黑屏。 */
            let playable = Self.inAppPlayableExtensions.contains(item.storedExtension)
            let primary = UIAction(
                title: playable ? "播放" : "用其他应用打开",
                image: UIImage(systemName: playable ? "play.circle" : "arrow.up.forward.app")
            ) { _ in
                if playable {
                    self.play(item, at: indexPath)
                } else {
                    self.share(item, at: indexPath)
                }
            }
            let share = UIAction(title: "分享本地文件", image: UIImage(systemName: "square.and.arrow.up")) { _ in
                self.share(item, at: indexPath)
            }
            return UIMenu(title: item.episodeTitle, children: [primary, share])
        }
    }

    override func tableView(
        _ tableView: UITableView,
        trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath
    ) -> UISwipeActionsConfiguration? {
        let item = items[indexPath.row]
        let delete = UIContextualAction(style: .destructive, title: "删除") { [weak self] _, _, done in
            guard let self = self else {
                done(false)
                return
            }
            confirmDeletion(
                on: self,
                title: "删除" + item.episodeTitle,
                message: "会删掉这一集的本地文件，不能恢复。"
            ) {
                self.delete(item)
            }
            done(true)
        }
        return UISwipeActionsConfiguration(actions: [delete])
    }

    // MARK: - 动作

    /// App 内播放器真的能播起来的容器。
    /// 分片合成的 .ts 和 .mkv 系统播放器打不开（打开就是黑屏 or 直接失败），这两类直接交给其他 App。
    static let inAppPlayableExtensions: Set<String> = ["mp4", "m4v", "mov"]

    private func play(_ item: DownloadLibraryItem, at indexPath: IndexPath? = nil) {
        guard let fileURL = resolvedFileURL(for: item) else {
            alert("这一集的文件已经不在了，请重新下载")
            return
        }
        guard Self.inAppPlayableExtensions.contains(fileURL.pathExtension.lowercased()) else {
            offerExternalOpen(for: fileURL, at: indexPath)
            return
        }
        guard let onPlay = onPlay else {
            /* 没有接线时自己也该能播：直接在这个界面弹系统播放器。 */
            let player = AVPlayer(url: fileURL)
            let controller = AVPlayerViewController()
            controller.player = player
            present(controller, animated: true) { player.play() }
            return
        }
        /* 播放单只装「已完成 + 本地真的存在 + App 内能播」的集，按集号排；
           选集 / 上一集 / 下一集都只在这份单子里走。 */
        let ordered = items
            .filter { $0.isDone && Self.inAppPlayableExtensions.contains($0.storedExtension) }
            .sorted { left, right in
                let leftNumber = Int(left.epKey) ?? Int.max
                let rightNumber = Int(right.epKey) ?? Int.max
                if leftNumber != rightNumber { return leftNumber < rightNumber }
                return left.episodeTitle.localizedStandardCompare(right.episodeTitle) == .orderedAscending
            }
        var episodes: [OfflineEpisode] = []
        var start = -1
        for candidate in ordered {
            guard let url = resolvedFileURL(for: candidate) else { continue }
            if candidate.id == item.id && candidate.showId == item.showId && candidate.epKey == item.epKey {
                start = episodes.count
            }
            episodes.append(OfflineEpisode(
                showId: candidate.showId,
                epKey: candidate.epKey,
                epLabel: candidate.episodeTitle,
                fileURL: url
            ))
        }
        guard start >= 0, !episodes.isEmpty else {
            alert("这一集的文件已经不在了，请重新下载")
            return
        }
        onPlay(OfflinePlaylist(showTitle: show.title, episodes: episodes), start)
    }

    private func share(_ item: DownloadLibraryItem, at indexPath: IndexPath) {
        guard let fileURL = resolvedFileURL(for: item) else {
            alert("这一集的文件已经不在了，请重新下载")
            return
        }
        let allowed: Set<String> = ["mp4", "m4v", "mov", "mkv", "ts"]
        guard allowed.contains(fileURL.pathExtension.lowercased()) else {
            alert("这个格式不能分享，请用 App 内播放")
            return
        }
        presentActivity(for: fileURL, at: indexPath)
    }

    /// App 内播不了的容器：说清楚原因，再交给系统「用其他应用打开」。
    private func offerExternalOpen(for fileURL: URL, at indexPath: IndexPath?) {
        let ext = fileURL.pathExtension.lowercased()
        let detail = ext.isEmpty ? "这一集的容器格式 App 自带播放器打不开。" : "这一集是 ." + ext + " 容器，App 自带播放器打不开。"
        let controller = UIAlertController(
            title: "App 内播不了这个格式",
            message: detail + "可以用「用其他应用打开」交给系统里的播放器。",
            preferredStyle: .alert
        )
        controller.addAction(UIAlertAction(title: "取消", style: .cancel))
        controller.addAction(UIAlertAction(title: "用其他应用打开", style: .default) { [weak self] _ in
            self?.presentActivity(for: fileURL, at: indexPath)
        })
        present(controller, animated: true)
    }

    /// 系统的分享 / 打开方式面板；iPad 上有 popover 锚点，不会崩。
    private func presentActivity(for fileURL: URL, at indexPath: IndexPath?) {
        let controller = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        if let popover = controller.popoverPresentationController {
            popover.sourceView = tableView
            if let indexPath = indexPath, let cell = tableView.cellForRow(at: indexPath) {
                popover.sourceRect = cell.frame
            } else {
                popover.sourceRect = CGRect(
                    x: tableView.bounds.midX, y: tableView.bounds.midY, width: 1, height: 1
                )
            }
        }
        present(controller, animated: true)
    }

    private func delete(_ item: DownloadLibraryItem) {
        /* 同上一级：最新记录 + 旧快照两份路径都删，删不干净就不删记录。 */
        let paths = downloadLibraryDeletionPaths(for: item, downloader: downloader)
        for path in paths {
            onStopPlayback?(path)
        }
        for path in paths where !downloader.removeDownloadedFile(at: path) {
            alert("删除本地文件失败，这一集还留着")
            return
        }
        downloader.deleteEpisode(
            id: item.id.isEmpty ? nil : item.id,
            showId: item.showId,
            epKey: item.epKey
        )
        reload(force: true)
        if items.isEmpty { navigationController?.popViewController(animated: true) }
    }

    /// 记录里的路径可能已经过时（确认框 / 快照都可能是几秒前的）：播放、分享、删除前都按最新记录取一次。
    private func livePath(for item: DownloadLibraryItem) -> String {
        let current = downloader.currentStoredPath(
            id: item.id.isEmpty ? nil : item.id,
            showId: item.showId,
            epKey: item.epKey
        )
        return current.isEmpty ? item.path : current
    }

    /// 只认三种东西同时成立：路径解析落在下载目录、磁盘上真的是普通文件、不是目录。
    private func resolvedFileURL(for item: DownloadLibraryItem) -> URL? {
        let path = livePath(for: item)
        guard !path.isEmpty, let fileURL = MediaDownloader.fileURL(forStoredPath: path) else { return nil }
        guard let directory = MediaDownloader.directory() else { return nil }
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        let target = fileURL.standardizedFileURL.resolvingSymlinksInPath()
        let rootComponents = root.pathComponents
        let targetComponents = target.pathComponents
        guard targetComponents.count == rootComponents.count + 1,
              Array(targetComponents.prefix(rootComponents.count)) == rootComponents else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory),
              !isDirectory.boolValue else { return nil }
        return target
    }

    private func alert(_ message: String) {
        let controller = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        controller.addAction(UIAlertAction(title: "好", style: .default))
        present(controller, animated: true)
    }
}

// MARK: - 集行

/// 一集的样式：本剧封面小图 + 集名 + 状态/进度；正在传的集在下面多一条进度条。
final class DownloadEpisodeCell: UITableViewCell {
    private let coverView = UIImageView()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()
    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let stack = UIStackView()
    private let textStack = UIStackView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = UIColor(white: 0.11, alpha: 1)
        selectionStyle = .default
        coverView.contentMode = .scaleAspectFill
        coverView.clipsToBounds = true
        coverView.layer.cornerRadius = 4
        coverView.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .preferredFont(forTextStyle: .body)
        titleLabel.textColor = .white
        detailLabel.font = .preferredFont(forTextStyle: .footnote)
        detailLabel.textColor = UIColor.white.withAlphaComponent(0.6)
        detailLabel.numberOfLines = 2
        progressView.progressTintColor = UIColor(red: 22.0 / 255.0, green: 224.0 / 255.0, blue: 90.0 / 255.0, alpha: 1)
        progressView.trackTintColor = UIColor(white: 0.25, alpha: 1)
        progressView.isHidden = true

        textStack.axis = .vertical
        textStack.spacing = 4
        textStack.addArrangedSubview(titleLabel)
        textStack.addArrangedSubview(detailLabel)
        textStack.addArrangedSubview(progressView)

        stack.axis = .horizontal
        stack.spacing = 10
        stack.alignment = .center
        stack.addArrangedSubview(coverView)
        stack.addArrangedSubview(textStack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            coverView.widthAnchor.constraint(equalToConstant: 28),
            coverView.heightAnchor.constraint(equalToConstant: 38),
            stack.leadingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -10),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(_ item: DownloadLibraryItem, cover: UIImage?) {
        coverView.image = cover
        titleLabel.text = item.episodeTitle
        detailLabel.text = item.statusText
        if item.status == "running" || item.status == "paused", let progress = item.fraction {
            progressView.isHidden = false
            progressView.progress = Float(progress)
        } else {
            progressView.isHidden = true
        }
        accessoryType = item.isDone ? .disclosureIndicator : .none
        selectionStyle = item.isDone ? .default : .none
    }
}

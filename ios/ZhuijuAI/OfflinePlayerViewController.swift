import AVFoundation
import UIKit

/// 离线播放的一集：文件已经解析过，一定是下载目录里的普通文件。
struct OfflineEpisode {
    let showId: String
    let epKey: String
    let epLabel: String
    let fileURL: URL

    /// 播放进度按「剧 + 集」记，换设备内重启、换一次进片库都能续上。
    var progressKey: String { showId + "|" + epKey }
}

/// 一次离线播放的任务单：一部剧**已经下载完成且在本地**的集，按集号排好。
/// 选集、上一集、下一集只允许在这份单子里走，下载中 / 失败的集不会出现在这里。
struct OfflinePlaylist {
    let showTitle: String
    var episodes: [OfflineEpisode]
}

/// 原生离线播放器：和在线播放同一套控件（进度条、倍速、上一集/下一集、选集、
/// 默认/拉伸/平铺、全屏横屏），片源是本机文件，飞行模式下一样能用。
///
/// 方向不在这里硬锁：全屏状态交给 `WebViewController` 统筹（在线播放也走那一套全局掩码），
/// 这样「全屏=横屏」「其他页面=竖屏」「横拿自动横屏」三个结论只在一处判断。
final class OfflinePlayerViewController: UIViewController {
    /// 画面模式：三种，和在线播放的默认 / 拉伸 / 平铺对应。
    enum VideoMode: Int, CaseIterable {
        case fit
        case aspectFill
        case stretch

        var title: String {
            switch self {
            case .fit: return "默认"
            case .aspectFill: return "拉伸"
            case .stretch: return "平铺"
            }
        }

        var gravity: AVLayerVideoGravity {
            switch self {
            case .fit: return .resizeAspect
            case .aspectFill: return .resizeAspectFill
            case .stretch: return .resize
            }
        }

        var next: VideoMode {
            switch self {
            case .fit: return .aspectFill
            case .aspectFill: return .stretch
            case .stretch: return .fit
            }
        }
    }

    /// 和在线播放共用同一份倍速表（AppBootstrap.js 里那九个档位）。
    static let speeds: [Double] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
    private static let progressStoreKey = "kj-ios-offline-progress"

    /// 全屏状态变化：`explicit` 表示是用户自己点了全屏 / 退出全屏，
    /// 由系统旋转引起的切换不需要再把屏幕方向反向抢一次。
    var onFullscreenChange: ((Bool, Bool) -> Void)?
    /// 用户关掉播放器（全屏里先退出全屏，再关）。
    var onClose: (() -> Void)?
    /// 方向与生命周期由 WebViewController 统一管理（在线播放也走那一套全局掩码）。
    weak var owner: WebViewController?

    private var playlist: OfflinePlaylist
    private var index: Int
    private let player = AVPlayer()
    private let playerLayer = AVPlayerLayer()

    private let stage = UIView()
    private let videoView = UIView()
    private let controls = UIView()
    private let topBar = UIView()
    private let bottomBar = UIView()
    private let backButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let modeButton = UIButton(type: .system)
    private let fullscreenButton = UIButton(type: .system)
    private let playButton = UIButton(type: .system)
    private let elapsedLabel = UILabel()
    private let durationLabel = UILabel()
    private let progressSlider = UISlider()
    private let speedButton = UIButton(type: .system)
    private let prevButton = UIButton(type: .system)
    private let nextButton = UIButton(type: .system)
    private let episodesButton = UIButton(type: .system)
    private let listHeader = UILabel()
    private let listTable = UITableView(frame: .zero, style: .plain)

    private var stageHeight: NSLayoutConstraint?
    private var listConstraints: [NSLayoutConstraint] = []
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var hideTimer: Timer?
    private var saveTimer: Timer?
    private var isFullscreen = false
    private var isScrubbing = false
    private var didSeekForResume = false
    private var videoMode: VideoMode = .fit

    init(playlist: OfflinePlaylist, startIndex: Int) {
        self.playlist = playlist
        self.index = min(max(0, startIndex), max(0, playlist.episodes.count - 1))
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        if let observer = timeObserver {
            player.removeTimeObserver(observer)
        }
        if let observer = endObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        NotificationCenter.default.removeObserver(self)
    }

    override var prefersStatusBarHidden: Bool { isFullscreen }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }

    // MARK: - 生命周期

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = .black
        configureStage()
        configureControls()
        configureList()
        IosAudioSession.playback()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(deviceOrientationChanged),
            name: UIDevice.orientationDidChangeNotification,
            object: nil
        )
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        loadCurrentEpisode(autoplay: true)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
        stopTimers()
        saveProgress()
        player.pause()
        IosAudioSession.release()
    }

    @objc private func appDidEnterBackground() {
        saveProgress()
    }

    /// 退出全屏后先锁竖屏；设备真的回到竖屏了才放开自动旋转，
    /// 否则手还横着会立刻又被判成「横拿」再进一次全屏。
    @objc private func deviceOrientationChanged() {
        guard !isFullscreen, WebViewController.offlineRotationLocked else { return }
        switch UIDevice.current.orientation {
        case .portrait, .portraitUpsideDown:
            owner?.unlockOfflineRotation()
        default:
            break
        }
    }

    // MARK: - 布局

    private func configureStage() {
        stage.backgroundColor = .black
        stage.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stage)

        videoView.backgroundColor = .black
        videoView.translatesAutoresizingMaskIntoConstraints = false
        stage.addSubview(videoView)

        playerLayer.player = player
        playerLayer.videoGravity = videoMode.gravity
        playerLayer.frame = view.bounds
        videoView.layer.addSublayer(playerLayer)

        controls.translatesAutoresizingMaskIntoConstraints = false
        stage.addSubview(controls)

        NSLayoutConstraint.activate([
            stage.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stage.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stage.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            videoView.leadingAnchor.constraint(equalTo: stage.leadingAnchor),
            videoView.trailingAnchor.constraint(equalTo: stage.trailingAnchor),
            videoView.topAnchor.constraint(equalTo: stage.topAnchor),
            videoView.bottomAnchor.constraint(equalTo: stage.bottomAnchor),
            controls.leadingAnchor.constraint(equalTo: stage.leadingAnchor),
            controls.trailingAnchor.constraint(equalTo: stage.trailingAnchor),
            controls.topAnchor.constraint(equalTo: stage.topAnchor),
            controls.bottomAnchor.constraint(equalTo: stage.bottomAnchor),
        ])
        let height = stage.heightAnchor.constraint(equalToConstant: 200)
        height.isActive = true
        stageHeight = height
        applyLayout()
    }

    /// 竖屏：视频在上（16:9），下面能看到这部剧的已下载集；全屏：视频铺满整块屏幕。
    private func applyLayout() {
        listHeader.isHidden = isFullscreen
        listTable.isHidden = isFullscreen
        /* 全屏时把列表的约束整个抬掉：只隐藏视图不够，
           上下两端都钉死的约束会把列表高度压成负数，系统直接报冲突。 */
        NSLayoutConstraint.deactivate(listConstraints)
        if !isFullscreen {
            NSLayoutConstraint.activate(listConstraints)
        }
        sizeStage()
        view.layoutIfNeeded()
        playerLayer.frame = videoView.bounds
    }

    private func sizeStage() {
        guard let height = stageHeight else { return }
        if isFullscreen {
            height.constant = max(view.bounds.height, UIScreen.main.bounds.height)
        } else {
            let width = view.bounds.width > 0 ? view.bounds.width : UIScreen.main.bounds.width
            height.constant = width * 9.0 / 16.0
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        sizeStage()
        playerLayer.frame = videoView.bounds
    }

    private func configureControls() {
        /* 顶部：返回（全屏里先退出全屏）、剧名 + 集名、画面模式、全屏。 */
        topBar.translatesAutoresizingMaskIntoConstraints = false
        controls.addSubview(topBar)

        configureIconButton(backButton, symbol: "chevron.left", action: #selector(backTapped))
        titleLabel.font = .preferredFont(forTextStyle: .subheadline)
        titleLabel.textColor = .white
        titleLabel.numberOfLines = 1
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        modeButton.titleLabel?.font = .preferredFont(forTextStyle: .footnote)
        modeButton.setTitleColor(.white, for: .normal)
        modeButton.addTarget(self, action: #selector(modeTapped), for: .touchUpInside)
        modeButton.translatesAutoresizingMaskIntoConstraints = false
        configureIconButton(fullscreenButton, symbol: "arrow.up.left.and.arrow.down.right", action: #selector(fullscreenTapped))

        topBar.addSubview(backButton)
        topBar.addSubview(titleLabel)
        topBar.addSubview(modeButton)
        topBar.addSubview(fullscreenButton)

        /* 底部：播放/暂停、时间、进度条、时长、倍速、上一集、下一集、选集。 */
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        controls.addSubview(bottomBar)

        configureIconButton(playButton, symbol: "pause.fill", action: #selector(playTapped))
        for label in [elapsedLabel, durationLabel] {
            label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
            label.textColor = .white
            label.translatesAutoresizingMaskIntoConstraints = false
            label.text = "00:00"
        }
        progressSlider.minimumTrackTintColor = UIColor(red: 22.0 / 255.0, green: 224.0 / 255.0, blue: 90.0 / 255.0, alpha: 1)
        progressSlider.maximumTrackTintColor = UIColor(white: 1, alpha: 0.3)
        progressSlider.setThumbImage(Self.thumbImage(), for: .normal)
        progressSlider.translatesAutoresizingMaskIntoConstraints = false
        progressSlider.addTarget(self, action: #selector(sliderTouchDown), for: .touchDown)
        progressSlider.addTarget(self, action: #selector(sliderChanged), for: .valueChanged)
        progressSlider.addTarget(self, action: #selector(sliderTouchUp), for: [.touchUpInside, .touchUpOutside, .touchCancel])

        speedButton.titleLabel?.font = .preferredFont(forTextStyle: .footnote)
        speedButton.setTitleColor(.white, for: .normal)
        speedButton.setTitle("倍速", for: .normal)
        speedButton.addTarget(self, action: #selector(speedTapped), for: .touchUpInside)
        speedButton.translatesAutoresizingMaskIntoConstraints = false

        configureIconButton(prevButton, symbol: "backward.end.fill", action: #selector(prevTapped))
        configureIconButton(nextButton, symbol: "forward.end.fill", action: #selector(nextTapped))
        episodesButton.titleLabel?.font = .preferredFont(forTextStyle: .footnote)
        episodesButton.setTitleColor(.white, for: .normal)
        episodesButton.setTitle("选集", for: .normal)
        episodesButton.addTarget(self, action: #selector(episodesTapped), for: .touchUpInside)
        episodesButton.translatesAutoresizingMaskIntoConstraints = false

        for item in [elapsedLabel, playButton, progressSlider, durationLabel, speedButton, prevButton, nextButton, episodesButton] {
            bottomBar.addSubview(item)
        }

        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: controls.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: controls.trailingAnchor),
            topBar.topAnchor.constraint(equalTo: controls.safeAreaLayoutGuide.topAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 44),

            backButton.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 8),
            backButton.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            backButton.widthAnchor.constraint(equalToConstant: 40),
            backButton.heightAnchor.constraint(equalToConstant: 40),

            titleLabel.leadingAnchor.constraint(equalTo: backButton.trailingAnchor, constant: 4),
            titleLabel.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),

            fullscreenButton.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -8),
            fullscreenButton.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            fullscreenButton.widthAnchor.constraint(equalToConstant: 40),
            fullscreenButton.heightAnchor.constraint(equalToConstant: 40),

            modeButton.trailingAnchor.constraint(equalTo: fullscreenButton.leadingAnchor, constant: -4),
            modeButton.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            modeButton.widthAnchor.constraint(equalToConstant: 44),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: modeButton.leadingAnchor, constant: -6),

            bottomBar.leadingAnchor.constraint(equalTo: controls.leadingAnchor),
            bottomBar.trailingAnchor.constraint(equalTo: controls.trailingAnchor),
            bottomBar.bottomAnchor.constraint(equalTo: controls.safeAreaLayoutGuide.bottomAnchor),
            bottomBar.heightAnchor.constraint(equalToConstant: 76),

            playButton.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor, constant: 10),
            playButton.bottomAnchor.constraint(equalTo: bottomBar.bottomAnchor, constant: -6),
            playButton.widthAnchor.constraint(equalToConstant: 40),
            playButton.heightAnchor.constraint(equalToConstant: 40),

            elapsedLabel.leadingAnchor.constraint(equalTo: playButton.trailingAnchor, constant: 4),
            elapsedLabel.centerYAnchor.constraint(equalTo: playButton.centerYAnchor),
            elapsedLabel.widthAnchor.constraint(equalToConstant: 44),

            durationLabel.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -10),
            durationLabel.centerYAnchor.constraint(equalTo: playButton.centerYAnchor),
            durationLabel.widthAnchor.constraint(equalToConstant: 44),

            progressSlider.leadingAnchor.constraint(equalTo: elapsedLabel.trailingAnchor, constant: 4),
            progressSlider.trailingAnchor.constraint(equalTo: durationLabel.leadingAnchor, constant: -4),
            progressSlider.centerYAnchor.constraint(equalTo: playButton.centerYAnchor),

            speedButton.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor, constant: 12),
            speedButton.topAnchor.constraint(equalTo: bottomBar.topAnchor, constant: 2),
            episodesButton.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -12),
            episodesButton.centerYAnchor.constraint(equalTo: speedButton.centerYAnchor),
            nextButton.trailingAnchor.constraint(equalTo: episodesButton.leadingAnchor, constant: -10),
            nextButton.centerYAnchor.constraint(equalTo: speedButton.centerYAnchor),
            nextButton.widthAnchor.constraint(equalToConstant: 36),
            nextButton.heightAnchor.constraint(equalToConstant: 36),
            prevButton.trailingAnchor.constraint(equalTo: nextButton.leadingAnchor, constant: -6),
            prevButton.centerYAnchor.constraint(equalTo: speedButton.centerYAnchor),
            prevButton.widthAnchor.constraint(equalToConstant: 36),
            prevButton.heightAnchor.constraint(equalToConstant: 36),
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleControls))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        controls.addGestureRecognizer(tap)
        controls.isUserInteractionEnabled = true
        topBar.backgroundColor = UIColor(white: 0, alpha: 0.45)
        bottomBar.backgroundColor = UIColor(white: 0, alpha: 0.45)
        syncEpisodeChrome()
    }

    private func configureIconButton(_ button: UIButton, symbol: String, action: Selector) {
        let configuration = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
        button.setImage(UIImage(systemName: symbol, withConfiguration: configuration), for: .normal)
        button.tintColor = .white
        button.addTarget(self, action: action, for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
    }

    private static func thumbImage() -> UIImage {
        let size = CGSize(width: 14, height: 14)
        return UIGraphicsImageRenderer(size: size).image { _ in
            UIColor.white.setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
        }
    }

    private func configureList() {
        listHeader.font = .preferredFont(forTextStyle: .footnote)
        listHeader.textColor = UIColor.white.withAlphaComponent(0.65)
        listHeader.numberOfLines = 0
        listHeader.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(listHeader)

        listTable.backgroundColor = .black
        listTable.separatorColor = UIColor(white: 0.2, alpha: 1)
        listTable.dataSource = self
        listTable.delegate = self
        listTable.register(UITableViewCell.self, forCellReuseIdentifier: "episode")
        listTable.rowHeight = 52
        listTable.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(listTable)

        guard let height = stageHeight else { return }
        listConstraints = [
            stage.bottomAnchor.constraint(equalTo: listHeader.topAnchor, constant: -10),
            listHeader.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            listHeader.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            listTable.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            listTable.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            listTable.topAnchor.constraint(equalTo: listHeader.bottomAnchor, constant: 6),
            listTable.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ]
        NSLayoutConstraint.activate(listConstraints)
        height.isActive = true
        listHeader.text = "《" + playlist.showTitle + "》已下载 " + String(playlist.episodes.count) + " 集 · 离线可播"
    }

    // MARK: - 播放

    private var current: OfflineEpisode? {
        guard index >= 0, index < playlist.episodes.count else { return nil }
        return playlist.episodes[index]
    }

    private func loadCurrentEpisode(autoplay: Bool) {
        guard let episode = current else { return }
        didSeekForResume = false
        let item = AVPlayerItem(url: episode.fileURL)
        player.replaceCurrentItem(with: item)
        player.playbackRate = Float(Self.savedSpeed())
        speedButton.setTitle(Self.speedText(Self.savedSpeed()), for: .normal)
        observePlayback()
        syncEpisodeChrome()
        if autoplay { player.play() }
        startTimers()
        updatePlayButton()
    }

    private func observePlayback() {
        if let observer = timeObserver {
            player.removeTimeObserver(observer)
        }
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            self?.updateProgress(time: time)
        }
        if endObserver == nil {
            /* 一个监听就够：换集后通知里的对象会变，只认当前那一条。 */
            endObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: nil,
                queue: .main
            ) { [weak self] note in
                guard let self = self,
                      let item = note.object as? AVPlayerItem,
                      item === self.player.currentItem else { return }
                self.itemDidFinish()
            }
        }
    }

    @objc private func itemDidFinish() {
        saveProgress(position: 0, key: current?.progressKey)
        if index + 1 < playlist.episodes.count {
            index += 1
            loadCurrentEpisode(autoplay: true)
            listTable.reloadData()
            return
        }
        player.pause()
        updatePlayButton()
        progressSlider.value = 0
    }

    private func updateProgress(time: CMTime) {
        guard !isScrubbing else { return }
        let seconds = time.seconds.isFinite ? time.seconds : 0
        let duration = player.currentItem?.duration.seconds ?? 0
        guard duration.isFinite, duration > 0 else {
            elapsedLabel.text = Self.timeText(seconds)
            return
        }
        /* 时隔很久才换到的时长（HLS/本地文件都可能）只在这里认一次，顺手做续播。 */
        durationLabel.text = Self.timeText(duration)
        progressSlider.maximumValue = Float(duration)
        progressSlider.value = Float(min(max(0, seconds), duration))
        elapsedLabel.text = Self.timeText(seconds)
        if !didSeekForResume, let episode = current {
            didSeekForResume = true
            let saved = Self.savedProgress(for: episode.progressKey)
            /* 快看完了就不续播，从头开始；否则点开就只剩片尾。 */
            if saved > 5, saved < duration - 10 {
                seek(to: saved)
            }
        }
    }

    private func seek(to seconds: Double) {
        let target = CMTime(seconds: seconds, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func syncEpisodeChrome() {
        guard let episode = current else { return }
        titleLabel.text = playlist.showTitle + " · " + episode.epLabel
        modeButton.setTitle(videoMode.title, for: .normal)
        prevButton.isEnabled = index > 0
        nextButton.isEnabled = index + 1 < playlist.episodes.count
        prevButton.alpha = prevButton.isEnabled ? 1 : 0.35
        nextButton.alpha = nextButton.isEnabled ? 1 : 0.35
        listHeader.text = "《" + playlist.showTitle + "》已下载 " + String(playlist.episodes.count) + " 集 · 离线可播"
        listTable.reloadData()
    }

    private func updatePlayButton() {
        let symbol = player.timeControlStatus == .playing ? "pause.fill" : "play.fill"
        let configuration = UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)
        playButton.setImage(UIImage(systemName: symbol, withConfiguration: configuration), for: .normal)
    }

    // MARK: - 计时与进度保存

    private func startTimers() {
        hideTimer?.invalidate()
        let timer = Timer(timeInterval: 4, repeats: false) { [weak self] _ in
            self?.setControlsHidden(true)
        }
        RunLoop.main.add(timer, forMode: .common)
        hideTimer = timer

        saveTimer?.invalidate()
        let saver = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            self?.saveProgress()
        }
        RunLoop.main.add(saver, forMode: .common)
        saveTimer = saver
    }

    private func stopTimers() {
        hideTimer?.invalidate()
        hideTimer = nil
        saveTimer?.invalidate()
        saveTimer = nil
    }

    private func saveProgress(position: Double? = nil, key: String? = nil) {
        let episode = key.flatMap { wanted in playlist.episodes.first { $0.progressKey == wanted } } ?? current
        guard let episode = episode else { return }
        let seconds = position ?? player.currentTime().seconds
        guard seconds.isFinite, seconds >= 0 else { return }
        var store = Self.readProgressStore()
        store[episode.progressKey] = seconds
        UserDefaults.standard.set(store, forKey: Self.progressStoreKey)
    }

    private static func readProgressStore() -> [String: Double] {
        UserDefaults.standard.dictionary(forKey: progressStoreKey) as? [String: Double] ?? [:]
    }

    static func savedProgress(for key: String) -> Double {
        readProgressStore()[key] ?? 0
    }

    static func savedSpeed() -> Double {
        let value = UserDefaults.standard.double(forKey: "kj-speed")
        return speeds.contains(value) ? value : 1
    }

    private func setControlsHidden(_ hidden: Bool) {
        UIView.animate(withDuration: 0.2) {
            self.topBar.alpha = hidden ? 0 : 1
            self.bottomBar.alpha = hidden ? 0 : 1
        }
    }

    // MARK: - 动作

    @objc private func toggleControls() {
        let hidden = topBar.alpha < 0.5
        setControlsHidden(!hidden)
        if hidden { startTimers() }
    }

    @objc private func backTapped() {
        if isFullscreen {
            setFullscreen(false, explicit: true)
            return
        }
        saveProgress()
        dismiss(animated: true) { [weak self] in
            self?.onClose?()
        }
    }

    @objc private func playTapped() {
        if player.timeControlStatus == .playing {
            player.pause()
            saveProgress()
        } else {
            player.play()
            setControlsHidden(false)
            startTimers()
        }
        updatePlayButton()
    }

    @objc private func sliderTouchDown() {
        isScrubbing = true
        stopTimers()
    }

    @objc private func sliderChanged() {
        elapsedLabel.text = Self.timeText(Double(progressSlider.value))
    }

    @objc private func sliderTouchUp() {
        seek(to: Double(progressSlider.value))
        isScrubbing = false
        startTimers()
        if player.timeControlStatus != .playing { updatePlayButton() }
    }

    @objc private func speedTapped() {
        let sheet = UIAlertController(title: "播放倍速", message: nil, preferredStyle: .actionSheet)
        let currentSpeed = Double(player.playbackRate)
        for speed in Self.speeds {
            let mark = abs(currentSpeed - speed) < 0.01 ? "✓ " : ""
            let title = mark + Self.speedText(speed)
            sheet.addAction(UIAlertAction(title: title, style: .default) { [weak self] _ in
                guard let self = self else { return }
                self.player.playbackRate = Float(speed)
                UserDefaults.standard.set(speed, forKey: "kj-speed")
                self.speedButton.setTitle(Self.speedText(speed), for: .normal)
            })
        }
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel))
        presentSheet(sheet)
    }

    @objc private func modeTapped() {
        videoMode = videoMode.next
        playerLayer.videoGravity = videoMode.gravity
        modeButton.setTitle(videoMode.title, for: .normal)
    }

    @objc private func fullscreenTapped() {
        setFullscreen(!isFullscreen, explicit: true)
    }

    @objc private func prevTapped() {
        guard index > 0 else { return }
        saveProgress()
        index -= 1
        loadCurrentEpisode(autoplay: true)
    }

    @objc private func nextTapped() {
        guard index + 1 < playlist.episodes.count else { return }
        saveProgress()
        index += 1
        loadCurrentEpisode(autoplay: true)
    }

    @objc private func episodesTapped() {
        let sheet = UIAlertController(title: "选集（只列已下载的集）", message: nil, preferredStyle: .actionSheet)
        for (offset, episode) in playlist.episodes.enumerated() {
            let label = episode.epLabel.isEmpty ? "第" + String(offset + 1) + "集" : episode.epLabel
            let title = (offset == index ? "✓ " : "") + label
            sheet.addAction(UIAlertAction(title: title, style: .default) { [weak self] _ in
                guard let self = self else { return }
                guard offset != self.index else { return }
                self.saveProgress()
                self.index = offset
                self.loadCurrentEpisode(autoplay: true)
            })
        }
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel))
        presentSheet(sheet)
    }

    /// 全屏状态：先改自己的布局，再让外层更新全局方向掩码。
    /// `explicit` = 用户点的按钮；系统旋转引起的切换不需要反向再抢一次方向。
    private func setFullscreen(_ on: Bool, explicit: Bool = false) {
        guard isFullscreen != on else { return }
        isFullscreen = on
        let symbol = on ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"
        let configuration = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
        fullscreenButton.setImage(UIImage(systemName: symbol, withConfiguration: configuration), for: .normal)
        applyLayout()
        setNeedsStatusBarAppearanceUpdate()
        onFullscreenChange?(on, explicit)
        setControlsHidden(false)
        startTimers()
    }

    /// 旋转由系统发起（系统未锁方向、手机横拿）：横过来就当全屏，转回竖屏就退出全屏。
    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        let landscape = size.width > size.height
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            guard let self = self else { return }
            if landscape && !self.isFullscreen {
                self.setFullscreen(true)
            } else if !landscape && self.isFullscreen {
                self.setFullscreen(false)
            }
        }
    }

    private func presentSheet(_ sheet: UIAlertController) {
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        present(sheet, animated: true)
    }

    private static func timeText(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "00:00" }
        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secs)
        }
        return String(format: "%02d:%02d", minutes, secs)
    }

    private static func speedText(_ speed: Double) -> String {
        if abs(speed - speed.rounded()) < 0.001 {
            return String(format: "%.0fx", speed)
        }
        return String(format: "%.2fx", speed)
    }

    /// 停掉同一个文件的播放（片库删这一集之前会调到这里）。
    func stopIfPlaying(_ fileURL: URL) {
        guard let episode = current,
              episode.fileURL.standardizedFileURL.path == fileURL.standardizedFileURL.path else { return }
        player.pause()
        saveProgress()
        dismiss(animated: false, completion: nil)
    }
}

// MARK: - 点一下画面：显示 / 隐藏控件（不抢按钮的点击）

extension OfflinePlayerViewController: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        !(touch.view is UIControl)
    }
}

// MARK: - 选集列表（竖屏时在视频下面）
extension OfflinePlayerViewController: UITableViewDataSource, UITableViewDelegate {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        playlist.episodes.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "episode", for: indexPath)
        let episode = playlist.episodes[indexPath.row]
        var content = cell.defaultContentConfiguration()
        content.text = episode.epLabel
        content.secondaryText = indexPath.row == index ? "正在播放 · 离线文件" : "已下载 · 离线可播"
        content.secondaryTextProperties.color = UIColor.white.withAlphaComponent(0.55)
        content.textProperties.color = .white
        cell.contentConfiguration = content
        cell.backgroundColor = indexPath.row == index ? UIColor(white: 0.16, alpha: 1) : UIColor(white: 0.09, alpha: 1)
        let selected = UIView()
        selected.backgroundColor = UIColor(white: 0.2, alpha: 1)
        cell.selectedBackgroundView = selected
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard indexPath.row != index else { return }
        saveProgress()
        index = indexPath.row
        loadCurrentEpisode(autoplay: true)
    }
}

/// 离线播放要出声：静音开关不该把视频变成哑的；退出时把会话还回去，
/// 免得锁屏后再也听不到别的 App。
enum IosAudioSession {
    static func playback() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback, options: [])
        try? session.setActive(true)
    }

    static func release() {
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }
}

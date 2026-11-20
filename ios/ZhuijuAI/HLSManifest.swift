import Foundation

/// HLS 清单解析（纯逻辑，不发任何网络请求）。
///
/// 只做「整集下载」真正用得到的部分：
/// - 主清单（#EXT-X-STREAM-INF）里按带宽、再按分辨率挑最高的一路；
/// - 媒体清单里的分片、#EXTINF 时长、媒体序号、#EXT-X-KEY（AES-128）、#EXT-X-MAP、#EXT-X-BYTERANGE；
/// - 相对 URI 按清单自己的地址解析；分片/密钥 URI 没带查询串时继承清单的查询串
///   （站点的 CDN 常把 token 挂在清单 URL 上，分片相对路径不带 query，不继承就会 403）。
///
/// 明确不做：SAMPLE-AES / DRM 的解密。解析层只把 method 原样报上去，由下载层明确拒绝。
struct HLSVariant: Equatable {
    var url: URL
    var bandwidth: Int
    var width: Int
    var height: Int
}

struct HLSKey: Equatable {
    /// METHOD 原样保留（NONE / AES-128 / SAMPLE-AES …）。
    var method: String
    var uri: URL?
    var iv: Data?

    var isAES128: Bool { method.caseInsensitiveCompare("AES-128") == .orderedSame }
}

struct HLSByteRange: Equatable {
    var offset: Int64
    var length: Int64
}

struct HLSSegment: Equatable {
    var url: URL
    var duration: Double
    var sequence: Int
    var key: HLSKey?
    var byteRange: HLSByteRange?
    /// #EXT-X-MAP 的初始化段（fMP4）：没有时长，合成时排在最前面。
    var isInitialization: Bool = false
}

struct HLSPlaylist: Equatable {
    var variants: [HLSVariant] = []
    var segments: [HLSSegment] = []
    var isEndList = false
    var targetDuration: Double = 0

    /// 只有「有变体、没有分片」才是主清单；两者都有时按媒体清单处理。
    var isMaster: Bool { !variants.isEmpty && segments.isEmpty }

    var totalDuration: Double {
        var total = 0.0
        for segment in segments where !segment.isInitialization {
            total += segment.duration
        }
        return total
    }

    /// fMP4 用 mp4 扩展名，纯 TS 分片用 ts。
    var container: String {
        for segment in segments where segment.isInitialization { return "mp4" }
        let path = (segments.first?.url.path ?? "").lowercased()
        if path.hasSuffix(".m4s") || path.hasSuffix(".mp4") || path.hasSuffix(".m4v") { return "mp4" }
        return "ts"
    }
}

enum HLSParser {
    /// 主清单里挑最高码率：带宽优先，带宽一样再看分辨率面积。
    static func bestVariant(_ variants: [HLSVariant]) -> HLSVariant? {
        var best: HLSVariant?
        for variant in variants {
            guard let current = best else {
                best = variant
                continue
            }
            let biggerBandwidth = variant.bandwidth > current.bandwidth
            let sameBandwidth = variant.bandwidth == current.bandwidth
            let biggerPicture = variant.width * variant.height > current.width * current.height
            if biggerBandwidth || (sameBandwidth && biggerPicture) {
                best = variant
            }
        }
        return best
    }

    static func parse(_ text: String, baseURL: URL) -> HLSPlaylist {
        var playlist = HLSPlaylist()
        let lines = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }

        var pendingVariant: [String: String]?
        var currentKey: HLSKey?
        var pendingRange: (length: Int64, offset: Int64?)?
        var rangeEnd: [String: Int64] = [:]
        var pendingDuration: Double?
        var mediaSequence = 0
        var mediaIndex = 0
        var mapURI: String?
        var mapKey: HLSKey?
        var mapRange: (length: Int64, offset: Int64?)?

        for line in lines {
            if line.isEmpty { continue }
            if line.hasPrefix("#") {
                if line.hasPrefix("#EXT-X-STREAM-INF:") {
                    pendingVariant = parseAttributes(String(line.dropFirst("#EXT-X-STREAM-INF:".count)))
                } else if line.hasPrefix("#EXT-X-MEDIA-SEQUENCE:") {
                    let raw = String(line.dropFirst("#EXT-X-MEDIA-SEQUENCE:".count))
                    mediaSequence = Int(raw.trimmingCharacters(in: .whitespaces)) ?? 0
                } else if line.hasPrefix("#EXT-X-TARGETDURATION:") {
                    let raw = String(line.dropFirst("#EXT-X-TARGETDURATION:".count))
                    playlist.targetDuration = Double(raw.trimmingCharacters(in: .whitespaces)) ?? 0
                } else if line.hasPrefix("#EXTINF:") {
                    let raw = String(line.dropFirst("#EXTINF:".count))
                    let value = raw.components(separatedBy: ",")[0].trimmingCharacters(in: .whitespaces)
                    pendingDuration = Double(value) ?? 0
                } else if line.hasPrefix("#EXT-X-KEY:") {
                    currentKey = parseKey(parseAttributes(String(line.dropFirst("#EXT-X-KEY:".count))), base: baseURL)
                } else if line.hasPrefix("#EXT-X-MAP:") {
                    let map = parseAttributes(String(line.dropFirst("#EXT-X-MAP:".count)))
                    mapURI = map["URI"]
                    mapKey = currentKey
                    mapRange = parseByteRange(map["BYTERANGE"])
                } else if line.hasPrefix("#EXT-X-BYTERANGE:") {
                    pendingRange = parseByteRange(String(line.dropFirst("#EXT-X-BYTERANGE:".count)))
                } else if line.hasPrefix("#EXT-X-ENDLIST") {
                    playlist.isEndList = true
                }
                continue
            }

            /* 非标签行：主清单里是变体地址，媒体清单里是分片地址。 */
            if let variant = pendingVariant {
                pendingVariant = nil
                if let url = resolve(line, base: baseURL) {
                    let resolution = variant["RESOLUTION"] ?? ""
                    let picture = resolution.components(separatedBy: "x")
                    let width = picture.count == 2 ? (Int(picture[0]) ?? 0) : 0
                    let height = picture.count == 2 ? (Int(picture[1]) ?? 0) : 0
                    playlist.variants.append(HLSVariant(
                        url: url,
                        bandwidth: Int(variant["BANDWIDTH"] ?? "") ?? 0,
                        width: width,
                        height: height
                    ))
                }
                continue
            }

            guard let url = resolve(line, base: baseURL) else { continue }
            var byteRange: HLSByteRange?
            if let range = pendingRange {
                let offset = range.offset ?? rangeEnd[line] ?? 0
                byteRange = HLSByteRange(offset: offset, length: range.length)
                rangeEnd[line] = offset + range.length
                pendingRange = nil
            }
            playlist.segments.append(HLSSegment(
                url: url,
                duration: pendingDuration ?? 0,
                sequence: mediaSequence + mediaIndex,
                key: currentKey,
                byteRange: byteRange
            ))
            mediaIndex += 1
            pendingDuration = nil
        }

        /* #EXT-X-MAP 是 fMP4 的初始化段：没有它，后面的分片单独拿出来放不了。
           这里直接插到最前面，下载/合成那一层就不用再区分是不是初始化段。 */
        if let raw = mapURI, let url = resolve(raw, base: baseURL) {
            var range: HLSByteRange?
            if let pending = mapRange {
                range = HLSByteRange(offset: pending.offset ?? 0, length: pending.length)
            }
            playlist.segments.insert(HLSSegment(
                url: url,
                duration: 0,
                sequence: -1,
                key: mapKey,
                byteRange: range,
                isInitialization: true
            ), at: 0)
        }
        return playlist
    }

    /// 属性串（A=1,B="x,y"）拆成字典：逗号在引号里不算分隔符。
    static func parseAttributes(_ text: String) -> [String: String] {
        var result: [String: String] = [:]
        var name = ""
        var value = ""
        var readingName = true
        var quoted = false
        for character in text {
            if readingName {
                if character == "=" {
                    readingName = false
                } else {
                    name.append(character)
                }
                continue
            }
            if quoted {
                if character == "\"" {
                    quoted = false
                } else {
                    value.append(character)
                }
                continue
            }
            if character == "\"" {
                quoted = true
            } else if character == "," {
                result[name.trimmingCharacters(in: .whitespaces)] = value
                name = ""
                value = ""
                readingName = true
            } else {
                value.append(character)
            }
        }
        if !name.isEmpty || !value.isEmpty {
            result[name.trimmingCharacters(in: .whitespaces)] = value
        }
        return result
    }

    /// 相对 URI 解析：绝对地址直接用；相对地址按清单地址补全。
    /// 分片没带查询串时继承清单自己的查询串（CDN 的 token 常挂在那里）。
    static func resolve(_ raw: String, base: URL) -> URL? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        if let absolute = URL(string: text), absolute.scheme != nil {
            return absolute
        }
        guard let resolved = URL(string: text, relativeTo: base)?.absoluteURL else { return nil }
        guard let query = base.query, !query.isEmpty, resolved.query == nil else { return resolved }
        var components = URLComponents(url: resolved, resolvingAgainstBaseURL: false)
        if components?.query == nil {
            components?.percentEncodedQuery = query
        }
        return components?.url ?? resolved
    }

    /// #EXT-X-BYTERANGE:长度[@偏移]
    static func parseByteRange(_ raw: String?) -> (length: Int64, offset: Int64?)? {
        guard let text = raw?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        let parts = text.components(separatedBy: "@")
        guard let length = Int64(parts[0]) else { return nil }
        let offset = parts.count > 1 ? Int64(parts[1]) : nil
        return (length, offset)
    }

    /// #EXT-X-KEY：METHOD=NONE 返回 nil（这一段不加密）。
    static func parseKey(_ attributes: [String: String], base: URL) -> HLSKey? {
        guard let method = attributes["METHOD"] else { return nil }
        if method.caseInsensitiveCompare("NONE") == .orderedSame { return nil }
        let uri = attributes["URI"].flatMap { resolve($0, base: base) }
        let iv = attributes["IV"].flatMap { data(fromHex: $0) }
        return HLSKey(method: method, uri: uri, iv: iv)
    }

    /// AES-128 的 IV 没写时按协议用媒体序号补齐 16 字节大端。
    static func defaultIV(sequence: Int) -> Data {
        var value = UInt64(max(0, sequence))
        var bytes = Data(count: 16)
        var index = 15
        while index >= 8 {
            bytes[index] = UInt8(value & 0xFF)
            value >>= 8
            index -= 1
        }
        return bytes
    }

    /// 0x... 十六进制转字节。
    static func data(fromHex text: String) -> Data? {
        var hex = text.trimmingCharacters(in: .whitespaces).lowercased()
        if hex.hasPrefix("0x") { hex.removeFirst(2) }
        guard !hex.isEmpty, hex.count % 2 == 0 else { return nil }
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        return data
    }
}

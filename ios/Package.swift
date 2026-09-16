// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RemoteAgent",
    // iOS is the product target; macOS is included so `swift build` can run a
    // source check on a Mac without an iOS destination or simulator.
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.executable(name: "RemoteAgent", targets: ["RemoteAgent"])],
    targets: [.executableTarget(name: "RemoteAgent", path: "Sources/RemoteAgent")]
)

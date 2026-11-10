// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UchiyomiCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "UchiyomiCore", targets: ["UchiyomiCore"])],
    targets: [
        .target(name: "UchiyomiCore", path: "Sources/Core"),
        .testTarget(name: "UchiyomiCoreTests", dependencies: ["UchiyomiCore"], path: "Tests/CoreTests")
    ]
)

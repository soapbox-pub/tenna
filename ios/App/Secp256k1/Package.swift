// swift-tools-version: 5.9
import PackageDescription

// libsecp256k1 v0.7.0, vendored from bitcoin-core/secp256k1 with only what
// Nostr needs: the core, x-only keys and BIP-340 signatures. Built as one
// translation unit plus its two precomputed tables, the way upstream's own
// build does. See `NostrCrypto.swift` for what Tenna uses it for.
let package = Package(
    name: "Secp256k1",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "CSecp256k1", targets: ["CSecp256k1"]),
    ],
    targets: [
        .target(
            name: "CSecp256k1",
            path: "Sources/CSecp256k1",
            sources: [
                "src/secp256k1.c",
                "src/precomputed_ecmult.c",
                "src/precomputed_ecmult_gen.c",
            ],
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("src"),
                .define("ENABLE_MODULE_EXTRAKEYS", to: "1"),
                .define("ENABLE_MODULE_SCHNORRSIG", to: "1"),
            ]
        ),
    ]
)

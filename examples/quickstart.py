"""AlgoTerminal quickstart — one paid /metric call and one paid /compare call,
against the TestNet deployment, settling real TestNet USDC over x402.

    python -m venv venv && . venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env     # then paste a funded TestNet mnemonic in
    python quickstart.py

Nothing here is AlgoTerminal-specific except the two URLs at the bottom. The
client is stock `x402-avm` — GoPlausible's Python SDK, the same vendor as the
facilitator this endpoint settles through — so the same twenty lines work
against any x402 endpoint on Algorand.

Deliberately plain, synchronous Python with no framework and no build step: the
point of this file is that you can read all of it in two minutes and paste the
parts you need into your own agent. It is the line-for-line twin of
`quickstart.mjs`; if you are choosing a language, choose the one your agent is
already written in, because the integration is the same shape in both.
"""

import base64
import json
import os
import sys

import algosdk
import requests
from algosdk.atomic_transaction_composer import AccountTransactionSigner
from x402 import x402ClientSync
from x402.http.clients.requests import x402_requests
from x402.mechanisms.avm.exact import ExactAvmClientScheme

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def load_dotenv(path: str = ".env") -> None:
    """Read `.env` into the environment, without a dependency.

    `quickstart.mjs` gets this from Node's own `--env-file-if-exists`. Python
    has no equivalent, and pulling in python-dotenv to read six lines of
    KEY=value would be the first dependency in this file that is not the x402
    client itself. Real environment variables win, so `TESTNET_PAYER_MNEMONIC=…
    python quickstart.py` still overrides the file.
    """
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_dotenv()

#: The TestNet deployment. Free TestNet USDC; nothing here costs real money.
BASE = os.environ.get(
    "ALGOTERMINAL_BASE_URL", "https://api-testnet-production-a3ec.up.railway.app"
).rstrip("/")

#: Algod, for building the payment transaction — NOT for reading AlgoTerminal's
#: data. The data is Algorand MainNet; the payment settles on TestNet. Those are
#: two different chains and this is the one the payment is on.
ALGOD_URL = os.environ.get("ALGOD_URL", "https://testnet-api.4160.nodely.dev")

EXPLORER = "https://testnet.explorer.perawallet.app/tx"

mnemonic = os.environ.get("TESTNET_PAYER_MNEMONIC", "").strip()
if mnemonic == "":
    print(
        "TESTNET_PAYER_MNEMONIC is not set.\n\n"
        "You need a TestNet account holding TestNet USDC (ASA 10458941):\n"
        "  1. Create an account and fund it with ALGO: https://bank.testnet.algorand.network\n"
        "  2. Opt it in to ASA 10458941, then get TestNet USDC from\n"
        "     https://faucet.circle.com (choose Algorand TestNet).\n"
        "  3. Put its 25-word mnemonic in .env as TESTNET_PAYER_MNEMONIC.\n\n"
        "This run costs 0.055 TestNet USDC — $0.005 for /metric and $0.05 for /compare.",
        file=sys.stderr,
    )
    raise SystemExit(1)

# ---------------------------------------------------------------------------
# The x402 client — this is the whole integration
# ---------------------------------------------------------------------------

account_sk = algosdk.mnemonic.to_private_key(mnemonic)


class LocalSigner:
    """The `ClientAvmSigner` protocol, implemented with algosdk.

    The SDK deliberately does not ship a concrete signer: it hands you the
    unsigned transactions of the atomic group and the indexes that are yours to
    sign, and nothing else. That is the whole point — your key stays in your
    process and never reaches the SDK, the facilitator or AlgoTerminal. The
    fee-payer transaction at the other index is left `None` on purpose; the
    facilitator signs that one, which is why this call costs you no ALGO.

    (The TypeScript twin gets this for free from `toClientAvmSigner`. Python
    has no such helper, so the fifteen lines below are it.)
    """

    def __init__(self, secret_key: str) -> None:
        self._signer = AccountTransactionSigner(secret_key)
        self._address = algosdk.account.address_from_private_key(secret_key)

    @property
    def address(self) -> str:
        return self._address

    def sign_transactions(
        self, unsigned_txns: list[bytes], indexes_to_sign: list[int]
    ) -> list[bytes | None]:
        signed: list[bytes | None] = []
        for i, txn_bytes in enumerate(unsigned_txns):
            if i not in indexes_to_sign:
                signed.append(None)
                continue
            txn = algosdk.encoding.msgpack_decode(base64.b64encode(txn_bytes).decode())
            # `AccountTransactionSigner` rather than the older `txn.sign(sk)`,
            # which algosdk 2.12 deprecates. It signs a list at chosen indexes,
            # which is exactly the shape this protocol method already has.
            signed_txn = self._signer.sign_transactions([txn], [0])[0]
            signed.append(base64.b64decode(algosdk.encoding.msgpack_encode(signed_txn)))
        return signed


client = x402ClientSync()
# `algorand:*` registers the scheme for both Algorand networks, so the same
# client works against the MainNet endpoint with no code change: the 402 itself
# names the chain, the asset and the amount, and the client obeys it.
client.register("algorand:*", ExactAvmClientScheme(LocalSigner(account_sk), algod_url=ALGOD_URL))

#: A `requests.Session` that pays. On a 402 it reads the payment requirements,
#: builds and signs the atomic group, and retries the request with a
#: `PAYMENT-SIGNATURE` header — so every call below looks like an ordinary GET.
pay = x402_requests(client)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def heading(title: str) -> None:
    print(f"\n{title}\n{'─' * len(title)}")


def settlement(res: requests.Response) -> dict | None:
    """The settlement receipt the service returns alongside the data."""
    header = res.headers.get("PAYMENT-RESPONSE")
    if header is None:
        return None
    try:
        return json.loads(base64.b64decode(header).decode())
    except Exception:
        return None


def report_settlement(res: requests.Response) -> None:
    receipt = settlement(res)
    if receipt is None or receipt.get("transaction") is None:
        print("  (no settlement receipt on this response)")
        return
    print(f"  paid · txid {receipt['transaction']}")
    print(f"  {EXPLORER}/{receipt['transaction']}")


def print_fact(fact: dict, indent: str = "  ") -> None:
    """One KpiFact, printed the way you would actually want to read it."""
    if fact.get("error") is not None:
        print(f"{indent}{fact['protocol']}/{fact['metric']}: unavailable — {fact['error']}")
        return
    value = (
        f"${fact['value']:,.0f}" if fact.get("unit") == "USD" else str(fact.get("value"))
    )
    print(f"{indent}{fact['protocol']}/{fact['metric']} = {value} {fact['unit']}")
    print(
        f"{indent}  confidence {fact['confidence']}"
        + (" (ESTIMATED)" if fact.get("is_estimated") else "")
        + f" · {fact['cache']}"
        + (" STALE" if fact.get("stale") else "")
        + f" · as_of {fact['as_of']}"
        + f" · methodology {fact['methodology_version']}"
    )
    # coverage is what turns an aggregate into an auditable one: it says how
    # many pools went in and how many the §3.6 filters dropped, so a TVL that
    # skipped 7 unpriced pools does not read as a TVL that valued them at zero.
    coverage = fact.get("coverage")
    if coverage is not None:
        print(
            f"{indent}  coverage: {coverage['entities']} entities, "
            f"{coverage['excluded']} excluded, basis {coverage['basis']}"
        )
    for note in fact.get("notes") or []:
        print(f"{indent}  note: {note}")


# ---------------------------------------------------------------------------
# 0. Look before you pay — /catalog is free
# ---------------------------------------------------------------------------

heading("0. What is for sale (free — no payment)")

catalog = requests.get(f"{BASE}/catalog", timeout=30).json()
print(
    f"  {catalog['service']}, methodology {catalog['methodology_version']}, {catalog['network']}"
)
for p in catalog["protocols"]:
    print(f"  {p['id']:<8} {p['class']:<8} {len(p['kpis'])} KPIs")
    # A declined KPI is a fact about the source, not a gap in coverage — and it
    # is readable here, for free, before you spend anything.
    for kpi, reason in (p.get("declined") or {}).items():
        print(f"           declines {kpi}: {reason[:100]}…")
for route in catalog["routes"]:
    # `available: false` means this deployment cannot serve the route (today,
    # /ask without an ANTHROPIC_API_KEY). It is still listed with its price, so
    # check the flag rather than assuming a listed route is callable.
    suffix = "" if route["available"] else "   (not available on this deployment)"
    print(f"  {route['method']:<4} {route['path']:<32} ${route['price_usdc']}{suffix}")

# ---------------------------------------------------------------------------
# 1. The 402, unpaid — what a payment demand actually looks like
# ---------------------------------------------------------------------------

heading("1. The price quote (still free — we just do not pay it)")

quote = requests.get(f"{BASE}/metric/tinyman/tvl", timeout=30)
print(f"  HTTP {quote.status_code}")
requirements = json.loads(base64.b64decode(quote.headers["payment-required"]).decode())
accepts = requirements["accepts"][0]
print(f"  {accepts['amount']} atomic units of ASA {accepts['asset']} on {accepts['network']}")
print(f"  to {accepts['payTo']}, within {accepts['maxTimeoutSeconds']}s")
fee_payer = (accepts.get("extra") or {}).get("feePayer") or "(nobody — you pay it)"
print(f"  network fee sponsored by {fee_payer}")

# ---------------------------------------------------------------------------
# 2. One paid /metric call
# ---------------------------------------------------------------------------

heading("2. GET /metric/tinyman/tvl — $0.005")

metric_res = pay.get(f"{BASE}/metric/tinyman/tvl", timeout=60)
if not metric_res.ok:
    print(f"  failed: HTTP {metric_res.status_code} {metric_res.text}", file=sys.stderr)
    raise SystemExit(1)
fact = metric_res.json()
print_fact(fact)
# Provenance is per-fetch, so a fact built from 400 pools carries hundreds of
# SourceRefs. Distinct names is what a human wants; the full array is in the
# response if you want to audit it.
source_names = list(dict.fromkeys(s["name"] for s in fact["source"]))
print(f"  sources: {', '.join(source_names)} ({len(fact['source'])} refs)")
report_settlement(metric_res)

# ---------------------------------------------------------------------------
# 3. One paid /compare call
# ---------------------------------------------------------------------------

heading("3. GET /compare — capital efficiency across all three — $0.05")

compare_res = pay.get(
    f"{BASE}/compare",
    params={"protocols": "tinyman,pact,folks", "metric": "capital_efficiency"},
    timeout=60,
)
if not compare_res.ok:
    print(f"  failed: HTTP {compare_res.status_code} {compare_res.text}", file=sys.stderr)
    raise SystemExit(1)
comparison = compare_res.json()

print(f"  metric: {comparison['metric']} ({comparison['unit']})")
for row in comparison["ranking"]:
    print(f"  #{row['rank']} {row['protocol']:<8} {row['value']}")
spread = comparison["spread"]
ratio = "" if spread["ratio"] is None else f" ({spread['ratio']}x)"
print(f"  spread: {spread['min']} … {spread['max']}{ratio}")
print(f"  ranking basis: {comparison['ranking_basis']}")

# The caveats are the part worth reading: they name legs on a different basis,
# legs that are estimates, and legs below the 0.7 confidence line.
print(f"  comparability: {comparison['comparability']['confidence']} (the MINIMUM across legs)")
for caveat in comparison["comparability"].get("caveats") or []:
    print(f"    caveat: {caveat}")

heading("  every leg, including any that failed")
for leg in comparison["facts"]:
    print_fact(leg, "  ")

report_settlement(compare_res)

# ---------------------------------------------------------------------------
# 4. Errors are free — the guarantee worth testing yourself
# ---------------------------------------------------------------------------

heading("4. A KPI Pact declines — 404, and NOT charged")

declined = pay.get(f"{BASE}/metric/pact/take_rate", timeout=60)
body = declined.json()
error = body.get("error") or {}
print(f"  HTTP {declined.status_code} {error.get('code')}")
print(f"  {error.get('message', '')}")
charged = "PRESENT (unexpected!)" if settlement(declined) else "none — you were not charged"
print(f"  settlement receipt: {charged}")

print("\nDone. Total spent: 0.055 TestNet USDC.")
print(
    f"Payments to {accepts['payTo']} are public: "
    f"{EXPLORER.replace('/tx', '/address')}/{accepts['payTo']}\n"
)

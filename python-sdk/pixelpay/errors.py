"""PixelPay error types."""

from dataclasses import dataclass, field
from typing import Optional


class PixelPayError(Exception):
    """Base error from PixelPay API."""

    def __init__(self, status: int, detail: str, type_: Optional[str] = None):
        self.status = status
        self.detail = detail
        self.type = type_
        super().__init__(detail)


@dataclass
class PaymentChallenge:
    """Structured 402 payment challenge."""

    status: int = 402
    type: str = ""
    title: str = "Payment Required"
    detail: str = ""
    amount: str = ""
    currency: str = "USDC"
    mpp_challenge: Optional[str] = None
    x402_challenge: Optional[str] = None


class PaymentRequiredError(PixelPayError):
    """402 Payment Required — caller must handle payment."""

    def __init__(self, challenge: PaymentChallenge):
        self.challenge = challenge
        super().__init__(402, challenge.detail, challenge.type)

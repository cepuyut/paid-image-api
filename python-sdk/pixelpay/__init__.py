"""PixelPay SDK — AI image & video generation with MPP/x402 payment."""

from .client import PixelPay
from .errors import PixelPayError, PaymentRequiredError

__version__ = "1.0.0"
__all__ = ["PixelPay", "PixelPayError", "PaymentRequiredError"]

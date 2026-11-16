import pytest

from pipeline import config


@pytest.fixture
def tmp_vault(tmp_path, monkeypatch):
    """Point the vault at an empty temporary folder."""
    monkeypatch.setattr(config, "VAULT_DIR", tmp_path / "vault")
    return tmp_path / "vault"

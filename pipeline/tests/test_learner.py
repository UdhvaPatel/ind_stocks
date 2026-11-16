"""The weekly learner: correct fitting, no future data, and a working gate."""
from datetime import date

import numpy as np
import pytest

from pipeline import learner
from pipeline.engine import Engine
from pipeline.tests.test_engine import _plain, synthetic_dataset


@pytest.fixture
def small_learner(monkeypatch):
    """Let the learner train on the small synthetic dataset."""
    monkeypatch.setattr(learner, "MIN_TRAIN_ROWS", 400)
    monkeypatch.setattr(learner, "GBM_PARAMS", dict(learner.GBM_PARAMS, min_samples_leaf=20, max_iter=30))


def test_monday():
    assert learner.monday(date(2026, 11, 15)) == date(2026, 11, 9)       # Sunday -> that week's Monday
    assert learner.monday(date(2026, 11, 16)) == date(2026, 11, 16)


def test_logistic_recovers_a_known_relationship():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(20000, 3))
    p = 1 / (1 + np.exp(-(0.3 + 1.2 * X[:, 0] - 0.7 * X[:, 1])))
    y = (rng.uniform(size=20000) < p).astype(float)
    m = learner.fit_logistic(X, y, l2=1.0)
    assert m["w"][0] == pytest.approx(0.3, abs=0.06)
    assert m["w"][1] == pytest.approx(1.2, abs=0.08) and m["w"][2] == pytest.approx(-0.7, abs=0.08)
    assert abs(m["w"][3]) < 0.06
    pred = learner.predict_logistic(m, X)
    assert np.mean((pred - y) ** 2) < np.mean((y.mean() - y) ** 2)


def test_heavy_penalty_shrinks_weights_toward_zero():
    rng = np.random.default_rng(1)
    X = rng.normal(size=(2000, 2))
    y = (X[:, 0] + rng.normal(size=2000) > 0).astype(float)
    loose, tight = learner.fit_logistic(X, y, l2=0.1), learner.fit_logistic(X, y, l2=5000.0)
    assert abs(tight["w"][1]) < 0.3 * abs(loose["w"][1])


def test_each_week_model_is_trained_only_on_earlier_sessions(small_learner):
    ds, cal = synthetic_dataset()
    eng = Engine(ds, cal)
    st = eng.states["AAA"]
    i = len(st.dates) - 30
    info = eng.learner.info("AAA", i)
    assert info is not None and info["rows"] >= 400
    week = learner.monday(st.dates[i + 1])
    assert date.fromisoformat(info["to"]) < week                       # nothing from that week or later
    p_lr, p_gbm = eng.learner.predict("AAA", i)
    assert 0 < p_lr < 1 and 0 < p_gbm < 1
    # An early row has too little history behind it: no model, no prediction.
    assert eng.learner.info("AAA", 40) is None
    assert np.isnan(eng.learner.predict("AAA", 40)[0])


def test_replay_equals_live_with_trained_models(small_learner):
    ds, cal = synthetic_dataset()
    full = Engine(ds, cal)
    days = list(ds.frames["AAA"].index)
    for k in (470, len(days) - 2):
        as_of = days[k]
        live = Engine(ds.truncated(as_of, cal.next_trading_day(as_of)), cal)
        a, b = _plain(full.book(as_of)), _plain(live.book(as_of))
        assert a == b, f"replay differs from live on {as_of}"
        parts = a["AAA"]["claims"]["dir"]["parts"]
        assert parts["logistic"] is not None and parts["trees"] is not None


def test_gate_gives_no_weight_to_models_on_pure_noise(small_learner):
    # The synthetic prices are a random walk: nothing is learnable, so the
    # trained models must not be allowed to move the probability far from 50%.
    ds, cal = synthetic_dataset()
    eng = Engine(ds, cal)
    cal_now = eng.calibration(eng.last_session)
    assert cal_now["dir_lr"] + cal_now["dir_gbm"] < 0.6
    book = eng.book(eng.last_session)
    assert all(abs(e["claims"]["dir"]["p_up"] - 0.5) < 0.12 for e in book.values())

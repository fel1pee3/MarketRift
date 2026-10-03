"""Controlled browser check of the normal journey; no external API calls."""

import json
import os
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


BASE = os.getenv("MARKETRIFT_WEB_TEST_URL", "http://127.0.0.1:3100")
TENANT_A = "11111111-1111-4111-8111-111111111111"
TENANT_B = "22222222-2222-4222-8222-222222222222"
PRODUCT = "33333333-3333-4333-8333-333333333333"
CSRF = "controlled-csrf-token"


def main():
    state = {"tenant": TENANT_A, "role": "owner", "product": None,
             "advanced_product_class": "test", "advanced_source_class": "test",
             "run": None, "posts": 0, "discoveries": 0, "csrf": 0, "normal_paths": []}

    def session():
        return {"user_id": "44444444-4444-4444-8444-444444444444", "email": "controlled@example.invalid",
                "display_name": "Revisor", "tenant_id": state["tenant"], "role": state["role"],
                "csrf_token": CSRF, "tenants": [
                    {"tenant_id": TENANT_A, "name": "Empresa A", "role": "owner"},
                    {"tenant_id": TENANT_B, "name": "Empresa B", "role": "viewer"}]}

    def handle(route):
        request = route.request
        path = urlparse(request.url).path.removeprefix("/v1/")
        method = request.method
        if method != "GET":
            assert request.headers.get("x-csrf-token") == CSRF, path
            state["csrf"] += 1
        status, result = 200, None
        if path == "auth/session":
            result = session()
        elif path == "auth/switch-tenant" and method == "POST":
            state["tenant"] = json.loads(request.post_data)["tenant_id"]
            state["role"] = "viewer" if state["tenant"] == TENANT_B else "owner"
            result = session()
        elif path == "experience":
            state["normal_paths"].append(path)
            visible = state["tenant"] == TENANT_A
            result = {"products": [state["product"]] if visible and state["product"] else [],
                      "sources": [], "discovery": [state["run"]] if visible and state["run"] else [],
                      "suggestions": [], "attention": []}
        elif path == "products" and method == "POST":
            payload = json.loads(request.post_data)
            assert payload["usage_classification"] == "real"
            state["posts"] += 1
            state["product"] = {"id": PRODUCT, **payload, "official_domain": None,
                                "discovery_paused": False}
            result = state["product"]
        elif path == "products" and method == "GET":
            result = [{"id": "55555555-5555-4555-8555-555555555555", "name": "Fixture interna",
                       "kind": "competitor", "website_url": None,
                       "usage_classification": state["advanced_product_class"]}]
        elif path == "sources":
            result = [{"id": "66666666-6666-4666-8666-666666666666",
                       "product_id": "55555555-5555-4555-8555-555555555555",
                       "source_type": "manual_review", "url": "https://example.invalid/reviews",
                       "usage_classification": state["advanced_source_class"]}]
        elif path == "products/55555555-5555-4555-8555-555555555555/classification" and method == "PATCH":
            state["advanced_product_class"] = json.loads(request.post_data)["usage_classification"]
            result = {"usage_classification": state["advanced_product_class"]}
        elif path == "sources/66666666-6666-4666-8666-666666666666/classification" and method == "PATCH":
            state["advanced_source_class"] = json.loads(request.post_data)["usage_classification"]
            result = {"usage_classification": state["advanced_source_class"]}
        elif path in {"source-runs", "imports", "documents", "members", "github-monitor"}:
            result = []
        elif path == "source-discovery":
            result = {"profiles": [], "runs": [], "candidates": [], "search_provider": "brave_optional"}
        elif path == "page-sources":
            result = {"sources": [], "runs": [], "snapshots": [], "changes": [],
                      "interpretations": [], "active_rule_version": 4}
        elif path == "source-discovery/profiles" and method == "POST":
            state["product"]["official_domain"] = json.loads(request.post_data)["official_domain"]
            result = {"product_id": PRODUCT, "official_domain": state["product"]["official_domain"]}
        elif path == f"source-discovery/profiles/{PRODUCT}/run" and method == "POST":
            state["discoveries"] += 1
            assert json.loads(request.post_data) == {"include_external_search": False}
            state["run"] = {"product_id": PRODUCT, "status": "pending", "partial": False,
                            "finished_at": None, "retry_after_at": None}
            result = state["run"]
        elif path == "evidence/search":
            assert "scope=normal" in request.url
            state["normal_paths"].append(path)
            result = {"items": [], "counts": [], "total": 0, "limit": 20, "offset": 0}
        else:
            status, result = 404, {"message": "Controlled route missing: " + path}
        route.fulfill(status=status, content_type="application/json", body=json.dumps(result))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("http://localhost:3001/v1/**", handle)
        page.goto(f"{BASE}/")
        page.get_by_text("Ainda não há concorrentes acompanhados", exact=False).wait_for()
        page.goto(f"{BASE}/concorrentes")
        page.get_by_role("heading", name="Adicionar concorrente").wait_for()
        page.get_by_label("Nome do concorrente").fill("Concorrente público")
        page.get_by_label("Domínio oficial", exact=True).first.fill("example.com")
        page.get_by_label("Confirmei o vínculo deste domínio com o concorrente.").check()
        page.get_by_role("button", name="Cadastrar e confirmar vínculo").click()
        page.get_by_text("Concorrente cadastrado.").wait_for()
        assert state["posts"] == 1
        page.get_by_role("button", name="Descobrir fontes").click()
        page.get_by_text("Última descoberta: em andamento", exact=False).wait_for()
        assert state["discoveries"] == 1
        assert page.get_by_role("button", name="Descobrir fontes").is_disabled()
        page.goto(f"{BASE}/investigar")
        page.get_by_text("Nenhuma evidência disponível nos filtros atuais.").wait_for()
        page.goto(f"{BASE}/fontes")
        page.get_by_role("heading", name="Classificação para a experiência normal").wait_for()
        assert page.get_by_label("Classificação do produto Fixture interna").input_value() == "test"
        source_label = "Classificação da fonte https://example.invalid/reviews"
        assert page.get_by_label(source_label).input_value() == "test"
        page.get_by_label(source_label).select_option("unreviewed")
        page.get_by_label(source_label).wait_for()
        assert state["advanced_source_class"] == "unreviewed"
        page.get_by_label(source_label).select_option("test")
        assert state["advanced_source_class"] == "test"
        page.goto(f"{BASE}/configuracoes")
        page.get_by_label("Trocar de empresa").select_option(TENANT_B)
        page.get_by_role("button", name="Trocar empresa").click()
        page.goto(f"{BASE}/concorrentes")
        page.get_by_text("Nenhum concorrente acompanhado nesta empresa.").wait_for()
        assert page.get_by_text("Concorrente público").count() == 0
        assert state["csrf"] >= 3
        assert set(state["normal_paths"]) == {"experience", "evidence/search"}
        assert not errors, errors
        browser.close()
    print("normal experience browser: passed")


if __name__ == "__main__":
    main()

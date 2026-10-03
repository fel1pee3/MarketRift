"""Controlled browser check for the competitor journey; never calls the real API."""

import json
import os
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


BASE = os.getenv("MARKETRIFT_WEB_TEST_URL", "http://127.0.0.1:3100")
TENANT_ONE = "11111111-1111-4111-8111-111111111111"
TENANT_TWO = "22222222-2222-4222-8222-222222222222"
PRODUCT = "33333333-3333-4333-8333-333333333333"
CSRF = "controlled-csrf-token"


def main():
    state = {
        "tenant": TENANT_ONE, "role": "owner", "products": [], "profiles": [],
        "runs": [], "candidates": [], "sources": [], "product_posts": 0, "profile_posts": 0,
        "run_posts": 0, "mutations_with_csrf": 0,
    }

    def session():
        return {"user_id": "44444444-4444-4444-8444-444444444444", "email": "controlled@example.invalid",
                "display_name": "Teste controlado", "tenant_id": state["tenant"], "role": state["role"],
                "csrf_token": CSRF, "tenants": [
                    {"tenant_id": TENANT_ONE, "name": "Empresa A", "role": "owner"},
                    {"tenant_id": TENANT_TWO, "name": "Empresa B", "role": "viewer"},
                ]}

    def handle(route):
        request = route.request
        path = urlparse(request.url).path.removeprefix("/v1/")
        method = request.method
        if method == "POST":
            assert request.headers.get("x-csrf-token") == CSRF, path
            state["mutations_with_csrf"] += 1
        result, status = None, 200
        if path == "auth/session":
            result = session()
        elif path == "auth/switch-tenant" and method == "POST":
            state["tenant"] = json.loads(request.post_data)["tenant_id"]
            state["role"] = "viewer" if state["tenant"] == TENANT_TWO else "owner"
            result = session()
        elif path == "products" and method == "GET":
            result = state["products"] if state["tenant"] == TENANT_ONE else []
        elif path == "products" and method == "POST":
            state["product_posts"] += 1
            payload = json.loads(request.post_data)
            result = {"id": PRODUCT, **payload}
            state["products"].append(result)
        elif path == "source-discovery" and method == "GET":
            result = {"profiles": state["profiles"] if state["tenant"] == TENANT_ONE else [],
                      "runs": state["runs"] if state["tenant"] == TENANT_ONE else [],
                      "candidates": state["candidates"] if state["tenant"] == TENANT_ONE else [],
                      "search_provider": "brave_optional"}
        elif path == "source-discovery/profiles" and method == "POST":
            state["profile_posts"] += 1
            payload = json.loads(request.post_data)
            result = {**payload, "product_name": "Concorrente controlado", "aliases": [],
                      "country_code": None, "languages": [], "official_urls": [],
                      "identity_version": 1, "discovery_paused": False}
            state["profiles"] = [result]
        elif path == f"source-discovery/profiles/{PRODUCT}/run" and method == "POST":
            state["run_posts"] += 1
            assert json.loads(request.post_data) == {"include_external_search": False}
            result = {"id": "55555555-5555-4555-8555-555555555555", "product_id": PRODUCT,
                      "identity_version": 1, "status": "pending", "error_code": None,
                      "pages_examined": 0, "candidates_seen": 0, "candidates_new": 0,
                      "created_at": "2026-10-03T12:00:00Z", "finished_at": None,
                      "retry_after_at": None, "partial": False, "include_external_search": False,
                      "external_search_status": "not_requested", "external_queries": 0,
                      "resource_failures": []}
            state["runs"] = [result]
        elif path == "page-sources":
            result = {"sources": [], "runs": [], "snapshots": [], "changes": [],
                      "interpretations": [], "active_rule_version": 4}
        elif path == "sources":
            result = state["sources"] if state["tenant"] == TENANT_ONE else []
        elif path in {"source-runs", "imports", "documents", "members", "github-monitor"}:
            result = []
        else:
            status, result = 404, {"message": "Controlled route missing: " + path}
        route.fulfill(status=status, content_type="application/json", body=json.dumps(result))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page()
        page_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.route("http://localhost:3001/v1/**", handle)
        page.goto(f"{BASE}/concorrentes")
        page.get_by_role("heading", name="Adicionar concorrente").wait_for()
        assert page.get_by_role("navigation", name="Navegação principal").get_by_role("link").all_text_contents() == [
            "Visão geral", "Concorrentes", "Investigar", "Configurações"]
        page.get_by_label("Nome do concorrente").fill("Concorrente controlado")
        page.get_by_label("Domínio oficial", exact=True).first.fill("http://example.com")
        page.get_by_label("Confirmei que este domínio pertence ao concorrente informado.").check()
        page.get_by_role("button", name="Cadastrar e confirmar vínculo").click()
        page.get_by_text("Informe apenas o domínio oficial HTTPS", exact=False).wait_for()
        assert state["product_posts"] == 0
        page.get_by_label("Nome do concorrente").fill("Concorrente controlado")
        page.get_by_label("Domínio oficial", exact=True).first.fill("example.com")
        page.get_by_label("Confirmei que este domínio pertence ao concorrente informado.").check()
        page.get_by_role("button", name="Cadastrar e confirmar vínculo").click()
        page.get_by_text("Concorrente cadastrado; vínculo confirmado.").wait_for()
        assert (state["product_posts"], state["profile_posts"]) == (1, 1)
        page.get_by_label("Nome do concorrente").fill("Concorrente controlado")
        page.get_by_label("Domínio oficial", exact=True).first.fill("example.com")
        page.get_by_label("Confirmei que este domínio pertence ao concorrente informado.").check()
        page.get_by_role("button", name="Cadastrar e confirmar vínculo").click()
        page.get_by_text("Concorrente existente reaproveitado; vínculo confirmado.").wait_for()
        assert (state["product_posts"], state["profile_posts"]) == (1, 1)
        page.get_by_role("button", name="Descobrir fontes").click()
        page.get_by_text("Descoberta: em andamento").wait_for()
        assert state["run_posts"] == 1
        assert page.get_by_role("button", name="Descobrir fontes").is_disabled()
        state["runs"][0].update(status="succeeded", partial=True, candidates_seen=2,
                                  candidates_new=2, finished_at="2026-10-03T12:01:00Z")
        state["candidates"] = [
            {"id": "66666666-6666-4666-8666-666666666666", "product_id": PRODUCT,
             "canonical_url": "https://example.com/pricing", "status": "pending",
             "identity_version": 1, "existing_source_id": None, "linked_source_id": None},
            {"id": "77777777-7777-4777-8777-777777777777", "product_id": PRODUCT,
             "canonical_url": "https://example.com/reviews", "status": "rights_pending",
             "identity_version": 1, "existing_source_id": None, "linked_source_id": None},
        ]
        state["sources"] = [{"id": "88888888-8888-4888-8888-888888888888", "product_id": PRODUCT,
                              "source_type": "github_issues", "last_checked_at": "2026-10-03T11:00:00Z",
                              "access_status": "authorized", "storage_permitted": True}]
        page.reload()
        page.get_by_text("Domínio confirmado:").wait_for()
        assert state["product_posts"] == 1
        summary = " ".join(page.get_by_label("Resumo de Concorrente controlado").inner_text().split())
        assert "1 fontes sugeridas" in summary
        assert "1 fontes cadastradas" in summary
        assert "1 fontes com coleta" in summary
        assert "Sim cobertura parcial" in summary
        assert "1 bloqueios" in summary
        assert not page.get_by_role("link", name="https://example.com/pricing").is_visible()
        page.get_by_text("Ver detalhes e fontes sugeridas").click()
        assert page.get_by_role("link", name="https://example.com/pricing").is_visible()
        state["role"] = "analyst"
        page.reload()
        assert page.get_by_role("heading", name="Adicionar concorrente").count() == 0
        assert page.get_by_role("button", name="Descobrir fontes").is_enabled()
        page.goto(f"{BASE}/configuracoes")
        page.get_by_label("Trocar de empresa").select_option(TENANT_TWO)
        page.get_by_role("button", name="Trocar empresa").click()
        page.get_by_text("Empresa B").first.wait_for()
        page.goto(f"{BASE}/concorrentes")
        page.get_by_text("Nenhum concorrente cadastrado nesta empresa.").wait_for()
        assert page.get_by_role("heading", name="Adicionar concorrente").count() == 0
        assert state["mutations_with_csrf"] >= 4
        page.get_by_text("Administração avançada").click()
        assert page.get_by_role("link", name="Produtos e fontes").count() == 1
        page.goto(f"{BASE}/investigar")
        page.get_by_role("link", name="Explorar evidências e linha do tempo").wait_for()
        page.goto(f"{BASE}/fontes")
        page.get_by_role("heading", name="Produtos", exact=True).wait_for()
        assert not page_errors, page_errors
        browser.close()
    print("competitors browser: passed (cadastro, repetição, descoberta, resumo, sessão, CSRF, papéis, tenant e rotas antigas)")


if __name__ == "__main__":
    main()

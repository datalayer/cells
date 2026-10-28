# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""The local Jupyter server of the Code cells example (`make jupyter-server`).

The example's *Jupyter (local)* kernel reaches it at
http://localhost:8888/api/jupyter-server with the development token, as
agent-runtimes' examples reach theirs. Its kernels import `datalayer_cells`
(install it in this environment, `pip install -e ".[live]"`), so Python reads
and writes the page's sheet live over the `datalayer.cells` comm.

A development server only: a fixed, public token and any origin.
"""

# ruff: noqa: F821 (`c` is the configuration Jupyter hands this file)

c.ServerApp.ip = "127.0.0.1"
c.ServerApp.port = 8888
c.ServerApp.port_retries = 0
c.ServerApp.open_browser = False
c.ServerApp.base_url = "/api/jupyter-server/"
c.IdentityProvider.token = "60c1661cc408f978c309d04157af55c9588ff9557c9380e4fb50785750703da6"
# The examples page (http://127.0.0.1:3077) is another origin.
c.ServerApp.disable_check_xsrf = True
c.ServerApp.allow_origin_pat = ".*"
c.ServerApp.allow_credentials = True
c.ServerApp.tornado_settings = {
    "headers": {
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "Accept, Authorization, Cache-Control, Content-Type, Origin, X-XSRFToken",
        "Access-Control-Allow-Credentials": "true",
    },
}

import http.server, os
os.chdir("/Users/thedudeleo/Documents/Home/CodeProjects/portfolio_v2")
http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=8765, bind="127.0.0.1")

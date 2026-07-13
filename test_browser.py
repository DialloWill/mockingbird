from modules.web_driver import BrowserAutomation

browser = BrowserAutomation()

print(browser.start_browser())
print(browser.open_website("https://example.com"))
input("Press Enter to close browser...")
print(browser.close_browser())
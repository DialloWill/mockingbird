import pyautogui
import time

class ComputerController:
    def __init__(self):
        pyautogui.PAUSE = 1
        pyautogui.FAILSAFE = True
        print("🖱️ Computer controller initialized!")
    
    def get_mouse_position(self):
        x, y = pyautogui.position()
        return f"Mouse is at: ({x}, {y})"
    
    def move_mouse(self, x, y):
        pyautogui.moveTo(x, y)
        return f"Moved mouse to: ({x}, {y})"
    
    def click_position(self, x, y):
        pyautogui.click(x, y)
        return f"Clicked at: ({x}, {y})"
    
    def type_text(self, text):
        pyautogui.write(text, interval=0.1)
        return f"Typed: {text}"
    
    def press_key(self, key):
        pyautogui.press(key)

        return f"Pressed key: {key}"
    
    def screenshot(self, filename="screenshot.png"):
        screenshot = pyautogui.screenshot()
        screenshot.save(f"data/{filename}")
        return f"Screenshot saved: {filename}"
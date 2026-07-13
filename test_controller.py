from modules.automation import ComputerController
import time

controller = ComputerController()

print(controller.get_mouse_position())
time.sleep(2)

print(controller.move_mouse(500, 500))
time.sleep(2)

print("Opening Notepad in 3 seconds...")
time.sleep(3)

controller.press_key('win')
time.sleep(1)
controller.type_text('notepad')
time.sleep(1)
controller.press_key('enter')
time.sleep(2)
controller.type_text("Hello! I am Jarvis, your AI assistant.")
time.sleep(1)
controller.press_key('enter')
controller.type_text("I can control your computer automatically!")
time.sleep(2)
print(controller.screenshot("jarvis_test.png"))
print("Check the data/ folder for your screenshot!")
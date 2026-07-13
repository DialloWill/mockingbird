from modules.brain import JarvisBrain

jarvis = JarvisBrain()

response = jarvis.think("Hello! What's your name?")
print(response)

print(jarvis.clear_memory())
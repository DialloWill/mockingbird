from modules.brain import JarvisBrain

jarvis = JarvisBrain()

print("=" * 50)
print(jarvis.think("My name is John"))
print("=" * 50)
print(jarvis.think("What's my name?"))
print("=" * 50)
print(jarvis.think("Tell me a dad joke"))
print("=" * 50)